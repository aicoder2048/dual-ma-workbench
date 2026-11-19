#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pandas",
#     "yfinance",  # 只在 Polygon 不可用时作为回退数据源
# ]
# ///
"""双均线分析：MA + EMA（默认 20/60/120），底扣价推演，趋势类型初判。

用法：
  uv run dma_analyze.py TSLA
  uv run dma_analyze.py TSLA --asof 2021-04-14
  uv run dma_analyze.py --csv prices.csv     # 需要 Date, Close 列（Volume 可选）

依赖用 PEP 723 写在文件开头，uv run 会自动装好。装了 yfinance 不代表用它：
实际数据源看报告第一行"数据来源"。

数据来源：默认先用 Polygon/Massive 付费 API（POLYGON_API_KEY，见 find_polygon_key 的查找顺序），
失败或历史不够长时回退 yfinance。--source polygon|yfinance 可强制只用一个。

输出是给人（或 agent）读的 Markdown 报告。趋势分类是启发式规则，阈值见常量，
只做初判，最终结论要结合图形和 SKILL.md 的判断流程。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

PERIODS = (20, 60, 120)
SLOPE_LOOKBACK = 5          # 用最近 5 根 K 线算均线斜率
FLAT_SLOPE_PCT = 0.05       # 日均变化 < 0.05% 视为走平（3 点钟）
STEEP_SLOPE_PCT = 0.5       # 20 线日均变化 > 0.5% 视为陡峭（1 点钟方向）
TANGLE_SPREAD_PCT = 4.0     # 三条 MA 最大最小差 / 价格 < 4% 视为缠绕
EXTREME_PCTL = 0.95         # 20 线乖离率处于自身历史 95% 分位以上 = 大幅乖离
PROJECT_DAYS = 10           # 底扣价推演天数
VOLUME_SPIKE = 2.0          # 成交量 > 50 日均量 2 倍 = 大量


HISTORY_YEARS = 3           # 取多少年日线（乖离率分位用全部历史）
MIN_BARS = max(PERIODS) + SLOPE_LOOKBACK + 1
POLYGON_BASE = "https://api.polygon.io"
DEFAULT_ENV = Path.home() / "Python/Playground/DualMovingAveragesTrading/.env"


def find_polygon_key(env_file: str | None) -> str | None:
    """查找顺序：环境变量 → --env-file → 当前目录及其父目录的 .env → DualMovingAveragesTrading/.env。"""
    if os.environ.get("POLYGON_API_KEY"):
        return os.environ["POLYGON_API_KEY"]
    candidates = [Path(env_file)] if env_file else []
    candidates += [d / ".env" for d in (Path.cwd(), *Path.cwd().parents)]
    candidates.append(DEFAULT_ENV)
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().removeprefix("export ").partition("=")
            if sep and key.strip() == "POLYGON_API_KEY" and value.strip():
                return value.strip().strip("'\"")
    return None


def polygon_json(url: str) -> dict:
    """GET 一个 Polygon URL；429 按 4s/8s/16s 退避重试，其他错误直接抛出。"""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                time.sleep(2 ** (attempt + 2))
                continue
            body = exc.read().decode(errors="replace")
            try:
                body = json.loads(body).get("message", body)
            except ValueError:
                pass
            raise RuntimeError(f"HTTP {exc.code} {body[:160]}") from None
    raise RuntimeError("unreachable")


def fetch_polygon(ticker: str, start: str, end: str, api_key: str) -> pd.DataFrame:
    """Polygon /v2/aggs 日线（复权），跟随 next_url 翻页。"""
    url = (f"{POLYGON_BASE}/v2/aggs/ticker/{urllib.parse.quote(ticker.upper())}/range/1/day/"
           f"{start}/{end}?adjusted=true&sort=asc&limit=50000")
    rows: list[dict] = []
    for _ in range(20):
        data = polygon_json(f"{url}&apiKey={api_key}")
        rows += data.get("results") or []
        url = data.get("next_url")
        if not url:
            break
    if not rows:
        raise RuntimeError(f"没有数据（status={data.get('status')}）")
    df = pd.DataFrame(rows)
    # t 是该交易日美东 00:00 对应的 UTC 毫秒时间戳
    df["Date"] = (pd.to_datetime(df["t"], unit="ms", utc=True)
                  .dt.tz_convert("America/New_York").dt.tz_localize(None).dt.normalize())
    df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
    return df.set_index("Date")[["Open", "High", "Low", "Close", "Volume"]]


def fetch_yfinance(ticker: str, start: str, end: str) -> pd.DataFrame:
    import yfinance as yf

    end_excl = (pd.Timestamp(end) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    df = yf.download(ticker, start=start, end=end_excl, auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df


def load_prices(ticker: str | None, csv: str | None, asof: str | None,
                env_file: str | None, source: str) -> tuple[pd.DataFrame, str]:
    """返回 (日线数据, 数据来源说明)。ticker 模式下先 Polygon，失败或不够长再 yfinance。"""
    end_ts = pd.Timestamp(asof) if asof else pd.Timestamp.today().normalize()
    if csv:
        df, src = pd.read_csv(csv, parse_dates=["Date"]).set_index("Date"), f"CSV {csv}"
    else:
        start = (end_ts - pd.DateOffset(years=HISTORY_YEARS)).strftime("%Y-%m-%d")
        end = end_ts.strftime("%Y-%m-%d")
        df, notes = None, []
        if source in ("auto", "polygon"):
            key = find_polygon_key(env_file)
            if not key:
                notes.append("Polygon：没找到 POLYGON_API_KEY")
            else:
                try:
                    got = fetch_polygon(ticker, start, end, key)
                    if len(got) >= MIN_BARS:
                        df, src = got, "Polygon/Massive（复权日线）"
                    else:
                        notes.append(f"Polygon：只有 {len(got)} 根 K 线（{got.index[0].date()} 起），不够用")
                except Exception as exc:  # 网络/权限/档位限制都退回 yfinance
                    notes.append(f"Polygon：{exc}")
        if df is None and source in ("auto", "yfinance"):
            df, src = fetch_yfinance(ticker, start, end), "yfinance（复权日线）"
        if df is None:
            sys.exit("取数失败：" + "；".join(notes))
        if notes:
            src += "；回退原因：" + "；".join(notes)
    if "Close" not in df.columns:
        sys.exit("数据里没有 Close 列")
    df = df.sort_index()
    df = df[df.index <= end_ts].dropna(subset=["Close"])
    if len(df) < MIN_BARS:
        sys.exit(f"数据只有 {len(df)} 根 K 线，至少需要 {MIN_BARS} 根（来源：{src}）")
    return df, src


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    for n in PERIODS:
        df[f"MA{n}"] = df["Close"].rolling(n).mean()
        df[f"EMA{n}"] = df["Close"].ewm(span=n, adjust=False).mean()
    df["BIAS20"] = (df["Close"] / df["MA20"] - 1) * 100
    return df


def slope_pct(series: pd.Series) -> float:
    """最近 SLOPE_LOOKBACK 根的日均变化率（%）。"""
    return (series.iloc[-1] / series.iloc[-1 - SLOPE_LOOKBACK] - 1) * 100 / SLOPE_LOOKBACK


def clock(s: float) -> str:
    if abs(s) < FLAT_SLOPE_PCT:
        return "3 点钟（走平）"
    if s >= STEEP_SLOPE_PCT:
        return "1 点钟（陡升）"
    if s > 0:
        return "2 点钟（上行）"
    if s <= -STEEP_SLOPE_PCT:
        return "5 点钟（陡降）"
    return "4 点钟（下行）"


def arrangement(row: pd.Series, kind: str) -> str:
    a, b, c = (row[f"{kind}{n}"] for n in PERIODS)
    if a > b > c:
        return "多头"
    if a < b < c:
        return "空头"
    return "混乱"


def last_cross(df: pd.DataFrame, kind: str, fast: int, slow: int) -> str:
    diff = (df[f"{kind}{fast}"] - df[f"{kind}{slow}"]).dropna()
    sign = diff.gt(0)
    flips = sign.ne(sign.shift()).iloc[1:]
    if not flips.any():
        return "无"
    when = flips[flips].index[-1]
    name = "金叉" if sign.loc[when] else "死叉"
    bars_ago = len(diff) - 1 - diff.index.get_loc(when)
    return f"{name} {when.date()}（{bars_ago} 根前）"


def drop_off(df: pd.DataFrame, n: int) -> dict:
    """MA(n) 的底扣价推演。明天要扣的是 close[-n]，第 k 天扣 close[-n+k-1]。"""
    close = df["Close"]
    c = close.iloc[-1]
    future = close.iloc[-n:-n + PROJECT_DAYS] if n > PROJECT_DAYS else close.iloc[-n:]
    below = int((future < c).sum())
    # 未来 n 天内，底扣价第一次低于现价是第几天（视频里"约 12 个交易日后扣到低值区"）
    all_future = close.iloc[-n:].reset_index(drop=True)
    hits = all_future[all_future < c]
    first_low = int(hits.index[0]) + 1 if len(hits) else None
    # 价格保持不变时，MA 在 PROJECT_DAYS 天后的值
    ma_now = df[f"MA{n}"].iloc[-1]
    ma_flat = ma_now + (c * len(future) - future.sum()) / n
    return {
        "tomorrow": float(future.iloc[0]),
        "mean": float(future.mean()),
        "max": float(future.max()),
        "below": below,
        "count": len(future),
        "first_low": first_low,
        "ma_flat_change_pct": (ma_flat / ma_now - 1) * 100,
    }


def classify(arr_ma: str, arr_ema: str, slopes: dict, spread_pct: float,
             bias_pctl: float) -> str:
    s20, s60, s120 = (slopes[n] for n in PERIODS)
    if spread_pct < TANGLE_SPREAD_PCT and abs(s60) < FLAT_SLOPE_PCT * 2:
        return "横盘震荡"
    bull = arr_ma == "多头" and arr_ema == "多头"
    bear = arr_ma == "空头" and arr_ema == "空头"
    if bull and min(s20, s60, s120) > 0:
        return "极度超买" if bias_pctl >= EXTREME_PCTL else "健康上涨"
    if bear and max(s20, s60, s120) < 0:
        return "极度超卖" if bias_pctl <= 1 - EXTREME_PCTL else "健康下跌"
    return "过渡态（排列或方向不一致）"


STRATEGY = {
    "横盘震荡": "基本不做。等末期标志性动作（大量/缺口/假跌破），且突破前高前已形成或即将形成多头排列，才小仓位埋伏；多头排列被破坏就走。",
    "健康上涨": "持有；回调到均线获支撑时，切小级别（1h/30m）等破线-拐头-交叉-多头排列后结构性加仓。不追高。",
    "极度超买": "不追，只看不做。有仓位分批止盈或上移止损，等回落后重新组织均线。",
    "健康下跌": "不抄底。反弹到均线附近是减仓/离场机会。",
    "极度超卖": "不抢反弹。均线理顺成多头排列前不买。",
    "过渡态（排列或方向不一致）": "条件不满足就不做。看底扣价推演：均线能否在合理时间内理顺？反弹若被中长期线压着多半是假动作。",
}


ET = ZoneInfo("America/New_York")
# 美股 16:00 收盘；Polygon Starter 档数据延迟 15 分钟，16:15 后最后一根才算收盘价。
# 不处理提前收盘的半日市（13:00），那几天 13:15~16:15 会多提醒一次，无害。
BAR_FINAL_ET = dtime(16, 15)


def partial_bar_warning(last_bar: pd.Timestamp, now: datetime | None = None) -> str | None:
    """最后一根 K 线是今天（美东）且还没到收盘后，返回提醒文字（纯文本）；否则 None。"""
    now = (now or datetime.now(ET)).astimezone(ET)
    if last_bar.date() != now.date() or now.time() >= BAR_FINAL_ET:
        return None
    return (f"今日 K 线未完成（美东 {now:%H:%M}，收盘 16:00，数据可能延迟 15 分钟）。"
            "“收盘价”其实是盘中价格，结论相当于“假如今天收在这里”。"
            "底扣价比较、均线方向、交叉都可能在收盘前变化，下结论请等美东 16:15 后重跑。")


def analyze(df: pd.DataFrame, label: str, src: str) -> dict:
    """把三步分析算成结构化数据，Markdown 和 HTML 都从这里渲染。"""
    row = df.iloc[-1]
    c = float(row["Close"])
    slopes = {n: slope_pct(df[f"MA{n}"]) for n in PERIODS}
    ema_slopes = {n: slope_pct(df[f"EMA{n}"]) for n in PERIODS}
    arr_ma, arr_ema = arrangement(row, "MA"), arrangement(row, "EMA")
    mas = [row[f"MA{n}"] for n in PERIODS]
    spread_pct = float((max(mas) - min(mas)) / c * 100)
    bias_hist = df["BIAS20"].dropna()
    bias_pctl = float((bias_hist <= row["BIAS20"]).mean())
    trend = classify(arr_ma, arr_ema, slopes, spread_pct, bias_pctl)

    lines = [{"period": n, "ma": float(row[f"MA{n}"]), "ema": float(row[f"EMA{n}"]),
              "above": bool(c > row[f"MA{n}"]), "slope": slopes[n],
              "clock": clock(slopes[n]), "ema_clock": clock(ema_slopes[n])} for n in PERIODS]
    crosses = [{"pair": f"{fast}/{slow}", "ma": last_cross(df, "MA", fast, slow),
                "ema": last_cross(df, "EMA", fast, slow)} for fast, slow in ((20, 60), (60, 120))]
    volume = None
    if "Volume" in df.columns and df["Volume"].notna().any():
        vol_ratio = (df["Volume"] / df["Volume"].rolling(50).mean()).iloc[-20:]
        volume = {"ratio": float(vol_ratio.iloc[-1]),
                  "spikes": [str(d.date()) for d in vol_ratio[vol_ratio > VOLUME_SPIKE].index]}
    drops = []
    for n in PERIODS:
        d = drop_off(df, n)
        d["period"] = n
        d["direction"] = "上" if c > d["tomorrow"] else ("下" if c < d["tomorrow"] else "平")
        drops.append(d)
    prev = float(df["Close"].iloc[-2])
    return {
        "label": label, "date": str(df.index[-1].date()), "close": c,
        "change_pct": (c / prev - 1) * 100, "source": src,
        "warning": partial_bar_warning(df.index[-1]),
        "lines": lines, "arr_ma": arr_ma, "arr_ema": arr_ema,
        "spread_pct": spread_pct, "bias20": float(row["BIAS20"]), "bias_pctl": bias_pctl,
        "crosses": crosses, "volume": volume,
        "trend": trend, "strategy": STRATEGY[trend], "drops": drops,
    }


def render_markdown(a: dict) -> str:
    out = [f"# 双均线报告：{a['label']}（{a['date']}，收盘 {a['close']:.2f}）", "",
           f"数据来源：{a['source']}", ""]
    if a["warning"]:
        out += ["> [!warning] " + a["warning"], ""]
    out += ["## 1) 看大局", "",
            "| 周期 | MA | EMA | 价格在 MA 上/下 | MA 方向 | EMA 方向 |",
            "|---|---|---|---|---|---|"]
    for ln in a["lines"]:
        out.append(f"| {ln['period']} | {ln['ma']:.2f} | {ln['ema']:.2f} | {'上' if ln['above'] else '下'} | "
                   f"{ln['clock']} {ln['slope']:+.2f}%/日 | {ln['ema_clock']} |")
    out += ["",
            f"- 排列：MA **{a['arr_ma']}**，EMA **{a['arr_ema']}**",
            f"- 三条 MA 间距：{a['spread_pct']:.1f}% of 价格（< {TANGLE_SPREAD_PCT}% 视为缠绕）",
            f"- 20 线乖离率：{a['bias20']:+.1f}%，处于自身历史 {a['bias_pctl']:.0%} 分位",
            "- 最近交叉："]
    for x in a["crosses"]:
        out.append(f"  - {x['pair']}：MA {x['ma']}；EMA {x['ema']}")
    if a["volume"]:
        out.append(f"- 成交量：今日 {a['volume']['ratio']:.1f}× 50 日均量；近 20 日大量（>{VOLUME_SPIKE}×）："
                   + (", ".join(a["volume"]["spikes"]) or "无"))
    out += ["", f"**初判趋势类型：{a['trend']}**（启发式，需看图确认）", "",
            "## 2) 定策略", "", a["strategy"], "",
            f"## 3) 看方向：底扣价推演（未来 {PROJECT_DAYS} 天）", "",
            "| MA | 明天底扣价 | 明天 MA 方向（价格不变） | 未来扣价均值 | 未来扣价最高 | 低于现价的天数 | 价格不变时 MA 变化 | 第几天首次扣到低于现价 |",
            "|---|---|---|---|---|---|---|---|"]
    for d in a["drops"]:
        first = f"第 {d['first_low']} 天" if d["first_low"] else f"{d['period']} 天内都不会"
        out.append(f"| {d['period']} | {d['tomorrow']:.2f} | {d['direction']} | {d['mean']:.2f} | {d['max']:.2f} | "
                   f"{d['below']}/{d['count']} | {d['ma_flat_change_pct']:+.2f}% | {first} |")
    out += ["",
            "读法：底扣价低于现价 = 扣低值，股价不跌均线就上翘；高于现价 = 扣高值，股价要涨过它均线才不跌。",
            "“价格不变时 MA 变化”= 假设收盘价一直停在现价，推演期末 MA 相对今天的涨跌。"]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("ticker", nargs="?", help="股票代码，如 TSLA（需要 yfinance）")
    p.add_argument("--csv", help="本地 CSV，含 Date, Close（Volume 可选）")
    p.add_argument("--asof", help="回放到某天，如 2021-04-14")
    p.add_argument("--source", choices=("auto", "polygon", "yfinance"), default="auto",
                   help="数据源：auto=先 Polygon 再 yfinance（默认）")
    p.add_argument("--env-file", help="含 POLYGON_API_KEY 的 .env 路径")
    p.add_argument("--html", help="另外生成网页报告到这个路径（.html）")
    p.add_argument("--commentary", help="点评 JSON（格式见 html_report.py），放进网页报告")
    p.add_argument("--json", action="store_true",
                   help="改为输出 JSON：{analysis, chart}，给网页工作台和 agent 工具用")
    a = p.parse_args()
    if not a.ticker and not a.csv:
        p.error("需要 ticker 或 --csv")
    if a.commentary and not a.html:
        p.error("--commentary 需要和 --html 一起用")
    df, src = load_prices(a.ticker, a.csv, a.asof, a.env_file, a.source)
    df = add_indicators(df)
    result = analyze(df, (a.ticker or a.csv).upper() if a.ticker else a.csv, src)
    if a.json:
        from html_report import chart_data

        print(json.dumps({"analysis": result, "chart": chart_data(df, result)},
                         ensure_ascii=False, allow_nan=False))
        return
    print(render_markdown(result))
    if a.html:
        from html_report import load_commentary, render_html

        commentary = load_commentary(a.commentary) if a.commentary else None
        Path(a.html).write_text(render_html(result, df, commentary), encoding="utf-8")
        print(f"\n网页报告已写入：{Path(a.html).resolve()}")


if __name__ == "__main__":
    main()
