#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pandas",
#     "yfinance",  # 只在 Polygon 不可用时作为回退数据源
# ]
# ///
"""双均线分析：MA + EMA（默认 20/60/120），抵扣价推演，类型 × 阶段，逐条规则评估。

用法：
  uv run dma_analyze.py TSLA
  uv run dma_analyze.py TSLA --asof 2021-04-14
  uv run dma_analyze.py --csv prices.csv     # 需要 Date, Close 列（Volume 可选）

依赖用 PEP 723 写在文件开头，uv run 会自动装好。装了 yfinance 不代表用它：
实际数据源看报告第一行"数据来源"。

数据来源：默认先用 Polygon/Massive 付费 API（POLYGON_API_KEY，见 find_polygon_key 的查找顺序），
失败或历史不够长时回退 yfinance。--source polygon|yfinance 可强制只用一个。

输出是给人（或 agent）读的 Markdown 报告。规则的文字和来源在 references/rules.md，
计算在 regime.py（类型 × 阶段）和 rules.py（每条规则的状态、唯一的打法）。
需看图的规则脚本算不了，结论要结合图形。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, replace
from datetime import datetime, time as dtime
from enum import Enum
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

import earnings as ea
import regime as rg
import rules as rl
import tradeplan as tp
import volprofile as vp
from indicators import NAIVE_MA, PERIODS, add_indicators, arrangement
from projection import HURDLE_DAYS, extend, hurdle_path, projection
from hourly import load_hourly
from structure import find_structure, structure_json
from tones import bar_tones
from weekly import weekly_json

SLOPE_LOOKBACK = 5          # 方向（拐没拐）：用最近 5 根 K 线
FLAT_SLOPE_PCT = 0.05       # 脚本自定：日均变化 < 0.05% 算走平
PROJECT_DAYS = 10           # 抵扣价推演天数
ORDER_TIE_PCT = 0.5         # 脚本自定：两条线相差 < 价格的 0.5% 算贴在一起，不算上下
LEAN_LINES = (60, 120)      # 模糊判断看类型线组的两条 MA
LEAN_CLEAR = 0.6            # 脚本自定：|分数| ≥ 0.6 明显偏多 / 偏空
LEAN_SOME = 0.25            # 脚本自定：|分数| ≥ 0.25 偏多 / 偏空，否则不明
LEAN_LABELS = ("明显偏多", "偏多", "不明", "偏空", "明显偏空")
# 评估 H3 的"照方向持有"：类型是这两种才持有（references/evaluation.toml 的 H3.hold_types）。只给 MA200 对照用
HOLD_TYPES = ("稳定上涨", "加速上涨")

# JSON 的 thresholds：规则用到的每个数和它的性质（视频 / 校准值 / 脚本自定），rules.md 末尾有同一张表
THRESHOLDS = {
    "CLOCK_WINDOW": (rg.CLOCK_WINDOW, "脚本自定"), "CLOCK_SCALE": (rg.CLOCK_SCALE, "校准值"),
    "FLAT_DEG": (rg.FLAT_DEG, "视频"), "ACCEL_DEG": (rg.ACCEL_DEG, "视频"),
    "EXTREME_PCTL": (rg.EXTREME_PCTL, "脚本自定"), "RANGE_SPREAD_PCT": (rg.RANGE_SPREAD_PCT, "脚本自定"),
    "DENSE_PCT": (rg.DENSE_PCT, "视频"), "RANGE_MIN_DAYS": (rg.RANGE_MIN_DAYS, "视频"),
    "OPEN_LOOKBACK": (rg.OPEN_LOOKBACK, "脚本自定"), "ACCEL_START_LOOKBACK": (rg.ACCEL_START_LOOKBACK, "脚本自定"),
    "HURDLE_DAYS_60": (HURDLE_DAYS[60], "脚本自定"), "HURDLE_DAYS_120": (HURDLE_DAYS[120], "脚本自定"),
    "SLOPE_LOOKBACK": (SLOPE_LOOKBACK, "脚本自定"), "FLAT_SLOPE_PCT": (FLAT_SLOPE_PCT, "脚本自定"),
    "ORDER_TIE_PCT": (ORDER_TIE_PCT, "脚本自定"), "LEAN_CLEAR": (LEAN_CLEAR, "脚本自定"),
    "LEAN_SOME": (LEAN_SOME, "脚本自定"), "VOLUME_SPIKE": (rl.VOLUME_SPIKE, "脚本自定"),
    "VOLUME_PERSIST": (rl.VOLUME_PERSIST, "脚本自定"), "FAKE_MOVE_PCT": (rl.FAKE_MOVE_PCT, "脚本自定"),
    "FAKE_DAYS": (rl.FAKE_DAYS, "脚本自定"), "STOP_DAYS": (rl.STOP_DAYS, "脚本自定"),
    "BREAKOUT_BARS": (rl.BREAKOUT_BARS, "脚本自定"), "FRESH_BARS": (rl.FRESH_BARS, "脚本自定"),
    "PATTERN_RECENT_BARS": (rl.PATTERN_RECENT_BARS, "脚本自定"),
    "BIAS120_PCT": (rl.BIAS120_PCT, "视频"), "WEEKLY_BIAS120_PCT": (rl.WEEKLY_BIAS120_PCT, "视频"),
    "RR_MIN": (tp.RR_MIN, "视频"), "RR_IDEAL": (tp.RR_IDEAL, "视频"),
    "EARNINGS_WARN_DAYS": (ea.WARN_DAYS, "脚本自定"),
    "PROFILE_BINS": (vp.PROFILE_BINS, "脚本自定"), "PROFILE_EDGE": (vp.PROFILE_EDGE, "脚本自定"),
    "PROFILE_DAYS": (vp.PROFILE_DAYS, "脚本自定"),
}


def _plain(x):
    """asdict 之后把枚举换成它的中文值，Markdown 和 JSON 都直接用。"""
    if isinstance(x, Enum):
        return x.value
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_plain(v) for v in x]
    return x


NO_EARNINGS = {"available": False, "reason": "CSV 模式不取财报日"}

HISTORY_YEARS = 5           # 取多少年日线（周线 MA120 要 120 周）
DAILY_YEARS = 3             # 日线分析只看最近 3 年（乖离率分位用这段全部历史），和取 5 年之前一致
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


def windows(df: pd.DataFrame, end: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    """截到 end：(日线分析用的最近 DAILY_YEARS 年, 周线用的最近 HISTORY_YEARS 年)。实时、CSV、回放都这么切。"""
    history = df[(df.index <= end) & (df.index >= end - pd.DateOffset(years=HISTORY_YEARS))]
    return history[history.index >= end - pd.DateOffset(years=DAILY_YEARS)], history


def load_prices(ticker: str | None, csv: str | None, asof: str | None,
                env_file: str | None, source: str) -> tuple[pd.DataFrame, pd.DataFrame, str]:
    """返回 (日线分析用的数据, 周线用的历史, 数据来源说明)。ticker 模式下先 Polygon，失败或不够长再 yfinance。

    两种模式切法一样（windows）：CSV 只是换了数据来源，不给 asof 时截到文件最后一行。
    """
    end_ts = pd.Timestamp(asof) if asof else pd.Timestamp.today().normalize()
    if csv:
        df, src = pd.read_csv(csv, parse_dates=["Date"]).set_index("Date"), f"CSV {csv}"
        end_ts = end_ts if asof else df.index.max()
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
    daily, history = windows(df.sort_index().dropna(subset=["Close"]), end_ts)
    if len(daily) < MIN_BARS:
        sys.exit(f"数据只有 {len(daily)} 根 K 线，至少需要 {MIN_BARS} 根（来源：{src}）")
    return daily.copy(), history, src


def slope_pct(series: pd.Series) -> float:
    """最近 SLOPE_LOOKBACK 根的日均变化率（%）：方向用，不是钟表。"""
    return (series.iloc[-1] / series.iloc[-1 - SLOPE_LOOKBACK] - 1) * 100 / SLOPE_LOOKBACK


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
    """MA(n) 的抵扣价推演。明天要扣的是 close[-n]，第 k 天扣 close[-n+k-1]。"""
    close = df["Close"]
    c = close.iloc[-1]
    future = close.iloc[-n:-n + PROJECT_DAYS] if n > PROJECT_DAYS else close.iloc[-n:]
    below = int((future < c).sum())
    # 未来 n 天内，抵扣价第一次低于现价是第几天（视频里"约 12 个交易日后扣到低值区"）
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
        # 未来每天要扣的那根 K 线（日期 + 收盘价），网页画抵扣价小图用
        "path": [{"date": str(d.date()), "close": float(v)} for d, v in future.items()],
    }


def sign(x: float, tol: float) -> int:
    return 0 if abs(x) < tol else (1 if x > 0 else -1)


def lean_label(score: float) -> str:
    if score >= LEAN_CLEAR:
        return "明显偏多"
    if score >= LEAN_SOME:
        return "偏多"
    if score <= -LEAN_CLEAR:
        return "明显偏空"
    if score <= -LEAN_SOME:
        return "偏空"
    return "不明"


def line_votes(values: dict[str, float], slopes: dict[str, float], close: float) -> dict:
    """6 条线往哪走（方向）、20/60 和 60/120 谁在上（排布）。只作证据，不进分数。"""
    dirs = {k: sign(v, FLAT_SLOPE_PCT) for k, v in slopes.items()}
    tol = close * ORDER_TIE_PCT / 100
    pairs = [{"pair": f"{kind}{fast}/{kind}{slow}", "rel": sign(values[f"{kind}{fast}"] - values[f"{kind}{slow}"], tol)}
             for kind in ("MA", "EMA") for fast, slow in ((20, 60), (60, 120))]
    up = sum(d > 0 for d in dirs.values())
    down = sum(d < 0 for d in dirs.values())
    return {"up": up, "down": down, "flat": len(dirs) - up - down, "dirs": dirs,
            "order": sum(p["rel"] for p in pairs), "pairs": pairs}


def hold(df: pd.DataFrame, n: int) -> dict:
    """类型线 MA(n) 的安全边际：收盘不变时朝今天的方向连续走几天；K 天内天天这样走，收盘要守在哪（level）。"""
    c = float(df["Close"].iloc[-1])
    h = hurdle_path(df, n, HURDLE_DAYS[n])
    way = 1 if h.prices[0] < c else (-1 if h.prices[0] > c else 0)
    days = 0
    for p in h.prices:
        if way == 0 or (p - c) * way >= 0:
            break
        days += 1
    edge = h.max_price if way >= 0 else h.min_price
    return {"line": f"MA{n}", "direction": {1: "上", -1: "下", 0: "平"}[way], "hold_days": days, "days": h.days,
            "level": edge, "level_pct": (edge / c - 1) * 100}


def lean_of(df: pd.DataFrame) -> dict:
    """模糊判断：类型线组（MA60、MA120）朝哪走、收盘不变能保持几天。分数 = 两条线"带方向的保持天数 / 看的天数"的平均。"""
    row = df.iloc[-1]
    c = float(row["Close"])
    basis = [hold(df, n) for n in LEAN_LINES]
    score = sum({"上": 1, "下": -1, "平": 0}[b["direction"]] * b["hold_days"] / b["days"] for b in basis) / len(basis)
    values = {f"{k}{n}": float(row[f"{k}{n}"]) for n in PERIODS for k in ("MA", "EMA")}
    slopes = {f"{k}{n}": slope_pct(df[f"{k}{n}"]) for n in PERIODS for k in ("MA", "EMA")}
    return {"score": score, "label": lean_label(score), "basis": basis, **line_votes(values, slopes, c)}


def flip_levels(lines: list[dict], drops: list[dict], close: float) -> list[dict]:
    """什么会改变判断，两个方向都列：价位在现价上方的是"站上就转多"，在下方的是"跌破就转空"。

    每个周期两道门槛：EMA 是线本身（先拐），MA 是明天的抵扣价（后拐）。
    """
    out = []
    for ln, d in zip(lines, drops):
        n = ln["period"]
        for line, price, what in ((f"EMA{n}", ln["ema"], f"EMA{n}"), (f"MA{n}", d["tomorrow"], f"MA{n} 的抵扣价")):
            up = price > close
            verb, turn = ("站上", "向上") if up else ("跌破", "向下")
            out.append({"line": line, "price": price, "toward": "多" if up else "空",
                        "text": f"收盘{verb} {what}（{price:.2f}），{line} 拐头{turn}"})
    return out


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
            "抵扣价比较、均线方向、交叉都可能在收盘前变化，下结论请等美东 16:15 后重跑。")


def ma200_of(df: pd.DataFrame, regime: rg.Regime) -> dict:
    """MA200 朴素规则的对照：收盘在 MA200 上方持有、否则空仓，和双均线照方向持有（HOLD_TYPES）一不一致。

    只是对照，不进任何规则。日线窗口 3 年（约 756 根），够算 MA200；历史太短的票返回 available=False。
    """
    close = df["Close"]
    if len(close) < NAIVE_MA + SLOPE_LOOKBACK:
        return {"available": False, "reason": f"日线只有 {len(close)} 根，MA{NAIVE_MA} 对照要 {NAIVE_MA + SLOPE_LOOKBACK} 根"}
    ma = close.rolling(NAIVE_MA).mean()
    c, v = float(close.iloc[-1]), float(ma.iloc[-1])
    above = (close > ma)[ma.notna()]
    flips = above.ne(above.shift()).iloc[1:]
    cross = None
    if flips.any():
        when = flips[flips].index[-1]
        cross = {"kind": "上穿" if above.loc[when] else "下穿", "date": str(when.date()),
                 "bars_ago": len(above) - 1 - above.index.get_loc(when)}
    slope = float(slope_pct(ma))
    stance = "持有" if c > v else "空仓"
    dual = "持有" if regime.type is not None and regime.type.value in HOLD_TYPES else "空仓"
    return {"available": True, "period": NAIVE_MA, "value": v, "close_above": c > v, "distance_pct": (c / v - 1) * 100,
            "slope": slope, "direction": {1: "上", -1: "下", 0: "平"}[sign(slope, FLAT_SLOPE_PCT)],
            "last_cross": cross, "stance": stance, "dual_ma_stance": dual, "agrees": stance == dual}


def lean_after(df: pd.DataFrame) -> dict:
    """价格停在现价 PROJECT_DAYS 天后的模糊判断：把持平的收盘价接上去，用同一套算法再算一次。"""
    c = float(df["Close"].iloc[-1])
    res = lean_of(extend(df, [c] * PROJECT_DAYS))
    return {"days": PROJECT_DAYS, "score": res["score"], "label": res["label"],
            "up": res["up"], "down": res["down"], "flat": res["flat"]}


def analyze(df: pd.DataFrame, label: str, src: str, history: pd.DataFrame | None = None,
            hourly: dict | None = None, sizing: tp.Sizing | None = None, earnings: dict | None = None,
            tone_plugin: bool = False) -> dict:
    """把三步分析算成结构化数据，Markdown 和 HTML 都从这里渲染。

    history 是周线用的更长历史，默认就用 df；hourly 是 hourly.load_hourly 的结果，没有时 P13 需看图。
    sizing 是账户规模和每笔可承受亏损，只影响交易计划的股数；不给时只算每 1 万元风险对应多少股。
    earnings 是 earnings.load_earnings 的结果（只是信息，不进规则）；--csv 和回测、逐根扫描都不取（NO_EARNINGS），
    这样进程内的分析和 --csv 的输出逐字一样。
    tone_plugin：读本机的着色插件，P40–P45（黑绿线）照它的颜色判；默认不读，P40–P45 需看图，分析在每台机器上一样。
    """
    hourly = hourly or {"available": False, "reason": "没有取小时线"}
    row = df.iloc[-1]
    c = float(row["Close"])
    slopes = {n: slope_pct(df[f"MA{n}"]) for n in PERIODS}
    bias_hist = df["BIAS20"].dropna()
    bias_pctl = float((bias_hist <= row["BIAS20"]).mean())
    structure = find_structure(df)
    regime, p20 = rg.classify(df, structure, bias_pctl)
    p60 = rg.pair_progress(df, 60, 120)
    weekly = weekly_json(df if history is None else history)

    lines = [{"period": n, "ma": float(row[f"MA{n}"]), "ema": float(row[f"EMA{n}"]),
              "above": bool(c > row[f"MA{n}"]), "slope": slopes[n],
              "clock": rg.clock(df, f"MA{n}").hour, "ema_clock": rg.clock(df, f"EMA{n}").hour} for n in PERIODS]
    crosses = [{"pair": f"{fast}/{slow}", "ma": last_cross(df, "MA", fast, slow),
                "ema": last_cross(df, "EMA", fast, slow)} for fast, slow in ((20, 60), (60, 120))]
    volume = None
    if "Volume" in df.columns and df["Volume"].notna().any():
        vol_ratio = (df["Volume"] / df["Volume"].rolling(50).mean()).iloc[-20:]
        volume = {"ratio": float(vol_ratio.iloc[-1]),
                  "spikes": [str(d.date()) for d in vol_ratio[vol_ratio > rl.VOLUME_SPIKE].index]}
    drops = []
    for n in PERIODS:
        d = drop_off(df, n)
        d["period"] = n
        d["direction"] = "上" if c > d["tomorrow"] else ("下" if c < d["tomorrow"] else "平")
        drops.append(d)
    lean = lean_of(df)
    lean["flips"] = flip_levels(lines, drops, c)
    lean["after"] = lean_after(df)
    tones, tone_source = bar_tones(df, builtin_only=not tone_plugin)
    ctx = rl.Ctx(df=df, regime=regime, p20=p20, p60=p60, structure=structure, weekly=weekly, hourly=hourly,
                 tones=tones, tone_source=tone_source)
    plan = tp.build(ctx, sizing)
    results = rl.evaluate(replace(ctx, plan=plan))
    play = rl.build_play(regime, results)
    short = tp.verdict_line(plan)
    if short:
        play = {**play, "text": f"{play['text']}{short}", "rules": [*play["rules"], "P24"]}
    prev = float(df["Close"].iloc[-2])
    return {
        "label": label, "date": str(df.index[-1].date()), "close": c,
        "change_pct": (c / prev - 1) * 100, "source": src,
        "warning": partial_bar_warning(df.index[-1]),
        "lines": lines, "arr_ma": arrangement(row, "MA"), "arr_ema": arrangement(row, "EMA"),
        "spread_pct": rg.spread6(row), "bias20": float(row["BIAS20"]), "bias_pctl": bias_pctl,
        "crosses": crosses, "volume": volume,
        "regime": _plain(asdict(regime)), "steps": [_plain(asdict(p20)), _plain(asdict(p60))],
        "play": play, "trade_plan": tp.plan_json(plan), "bwl": rl.bwl_json(ctx.bwl, results), "rules": results,
        "thresholds": {k: {"value": v, "source": s} for k, (v, s) in THRESHOLDS.items()},
        "drops": drops, "lean": lean,
        "projection": projection(df), "structure": structure_json(df), "gaps": tp.gaps_json(df),
        "profile": vp.profile_json(ctx.profile), "weekly": weekly,
        "hourly": hourly, "ma200": ma200_of(df, regime),
        "earnings": earnings or NO_EARNINGS,
    }


def _turn_cell(t: dict | None) -> str:
    if not t:
        return "—"
    done = [f"{s['step']} {s['date'][5:]}" for s in t["steps"] if s["date"]]
    return f"{t['direction']} {t['progress']}/5" + (f"：{'，'.join(done)}" if done else "")


def ma200_line(m: dict) -> str:
    """报告最后一节"5) 对照"：MA200 朴素规则怎么说，和双均线照方向持有一不一致。"""
    if not m["available"]:
        return f"算不了：{m['reason']}。"
    x = m["last_cross"]
    cross = f"，{x['date']} {x['kind']}（{x['bars_ago']} 根前）" if x else "，窗口内没穿过"
    return (f"收盘在上方持有，否则空仓（只是对照，不进规则）。收盘在 MA{m['period']} {m['value']:.2f} "
            f"{'上方' if m['close_above'] else '下方'}（{m['distance_pct']:+.1f}%），{m['stance']}；MA{m['period']} 向{m['direction']}{cross}。"
            f"双均线照方向持有（稳定 / 加速上涨才持有）：{m['dual_ma_stance']}，{'一致' if m['agrees'] else '不一致'}。"
            "评估里 MA200 的收益/回撤（MAR 0.26）高于照方向持有（0.14），见 SKILL.md 评估结论。")


def _level(x: dict | None, word: str) -> str:
    if not x:
        return f"{word}：没有"
    price = "没有日线价位" if x["price"] is None else f"{x['price']:.2f}"
    text = x.get("condition") or x.get("reason")
    return f"{word}：{price}（{x['rule']}{'，解读' if x.get('source') == '解读' else ''}）{text}"


def plan_lines(tpj: dict) -> list[str]:
    """报告"2) 定策略"下的交易计划：空仓的五样（进场、止损、目标、盈亏比、股数），持仓的止损和目标。"""
    out = [f"**交易计划**（打法键：{tpj['key']}）", ""]
    for name, p in (("空仓", tpj["flat"]), ("持仓", tpj["holding"])):
        items = [_level(p["stop"], "止损")] if name == "持仓" else [_level(p["entry"], "进场"), _level(p["stop"], "止损")]
        if p["targets"]:
            items.append("目标：" + "；".join(f"{t['price']:.2f}（{t['kind']}，{t['date']}{'，解读' if t['source'] == '解读' else ''}）"
                                            for t in p["targets"]))
            items.append(p["at_target"])
        if p["mountain"]:
            m = p["mountain"]
            items.append(f"参考：上方最近的筹码山 {m['foot']:.2f}–{m['top']:.2f}，只作参考，不算盈亏比（P38）")
        if name == "空仓" and p["entry"]:
            items.append(f"盈亏比：{tp.RR_FAR}" if p["entry"]["far"] else
                         f"盈亏比：{p['rr']:.2f}:1，{p['rr_verdict']}" if p["rr"] is not None else "盈亏比：算不了")
            z = p["size"]
            if z:
                items.append(f"股数：{z['shares']} 股（{z['basis']}）" if z["shares"] is not None else f"股数：{z['basis']}")
        items += p["notes"]
        out.append(f"- {name}：" + "；".join(items))
    return out


def render_markdown(a: dict) -> str:
    out = [f"# 双均线报告：{a['label']}（{a['date']}，收盘 {a['close']:.2f}）", "",
           f"数据来源：{a['source']}", ""]
    if a["warning"]:
        out += ["> [!warning] " + a["warning"], ""]
    ln, af, r = a["lean"], a["lean"]["after"], a["regime"]
    out += ["## 0) 模糊判断：接下来几周对谁有利", "",
            f"**{ln['label']}**（分数 {ln['score']:+.2f}，−1 最空、+1 最多）。依据是类型线组往哪走、能保持多久：", ""]
    for b in ln["basis"]:
        way = {"上": "上行", "下": "下行", "平": "走平"}[b["direction"]]
        side = "之上" if b["direction"] == "上" else "之下"
        out.append(f"- {b['line']} {way}：收盘不变能保持 {b['hold_days']}/{b['days']} 天；"
                   f"{b['days']} 天天天{way}要收盘守在 {b['level']:.2f}{side}（离现价 {b['level_pct']:+.1f}%）")
    out += [f"- 价格停在这里 {af['days']} 天后：{af['label']}（分数 {af['score']:+.2f}）",
            f"- 证据：6 条线 {ln['up']} 条向上、{ln['flat']} 条走平、{ln['down']} 条向下；"
            + "，".join(f"{p['pair']} {'>' if p['rel'] > 0 else '<' if p['rel'] < 0 else '≈'}" for p in ln["pairs"])]
    for toward, word in (("多", "转多"), ("空", "转空")):
        flips = [f["text"] for f in ln["flips"] if f["toward"] == toward and not f["line"].endswith("120")]
        if flips:
            out.append(f"- 什么会{word}（EMA 先拐、MA 后拐）：" + "；".join(flips))
    clk = f"60 线 {r['clock60']['angle']:+.0f}°（{r['clock60']['hour']}），20 线 {r['clock20']['angle']:+.0f}°（{r['clock20']['hour']}）"
    out += ["", "## 1) 看大局", "",
            f"**{r['name']}**" + (f"（{r['depth']}）" if r["depth"] else "") + f"。钟表：{clk}。",
            ""]
    if r["accel"]:
        out.append(f"- 加速出现在{rg.ACCEL_WHERE[r['accel']['phase']]}（按{r['accel']['by']}）")
    if r["range"]:
        g = r["range"]
        box = f"，箱体 {g['box_low']:.2f} ~ {g['box_high']:.2f}" if g["box_low"] and g["box_high"] else ""
        out.append(f"- 横盘：60 线走平 {g['days']} 根，6 条线相差 {g['spread_pct']:.1f}%{box}，张嘴：{g['opening'] or '没有'}")
    out += ["", "| 周期 | MA | EMA | 价格在 MA 上/下 | MA 方向（5 日） | MA 钟表 | EMA 钟表 |", "|---|---|---|---|---|---|---|"]
    for line in a["lines"]:
        out.append(f"| {line['period']} | {line['ma']:.2f} | {line['ema']:.2f} | {'上' if line['above'] else '下'} | "
                   f"{line['slope']:+.2f}%/日 | {line['clock']} | {line['ema_clock']} |")
    out += ["", f"- 排列：MA **{a['arr_ma']}**，EMA **{a['arr_ema']}**；6 条线相差 {a['spread_pct']:.1f}% of 价格",
            f"- 20 线乖离率：{a['bias20']:+.1f}%，处于自身历史 {a['bias_pctl']:.0%} 分位",
            "- 五步进度（破线、EMA 拐头、MA 拐头、第一个交叉、双交叉）："]
    for p in a["steps"]:
        out.append(f"  - {p['pair']}（{p['side'] or '未定'}）：上一次 {_turn_cell(p['completed'])}；现在 {_turn_cell(p['current'])}")
    w, h = a["weekly"], a["hourly"]
    out.append(f"- 周线：MA {w['arr_ma']}、EMA {w['arr_ema']}" if w["available"] else f"- 周线：{w['reason']}")
    out.append(f"- 小时线（到 {h['last']}）：MA {h['arr_ma']}、EMA {h['arr_ema']}" if h["available"]
               else f"- 小时线：{h['reason']}")
    e = a["earnings"]
    if e["available"]:
        out.append(f"- 下次财报：{e['next']}（{e['days_to_next']} 个交易日后）" if e["next"] else "- 下次财报：还没公布")
    else:
        out.append(f"- 财报日：{e['reason']}")
    if a["volume"]:
        out.append(f"- 成交量：今日 {a['volume']['ratio']:.1f}× 50 日均量；近 20 日大量（>{rl.VOLUME_SPIKE}×）："
                   + (", ".join(a["volume"]["spikes"]) or "无"))
    pf = a["profile"]
    if pf["available"]:
        mts = "、".join(f"{m['foot']:.2f}–{m['top']:.2f}（{m['share']:.0%}）" for m in pf["mountains"]) or "没有"
        out.append(f"- 筹码山（{pf['start']} ~ {pf['end']}，只当价位和目标参考，不是买卖信号）：{mts}")
    out += ["", "## 2) 定策略", "", a["play"]["text"], "", f"用到的规则：{'、'.join(a['play']['rules'])}", ""]
    out += plan_lines(a["trade_plan"])
    b = a["bwl"]
    if b["source"]["key"] == "plugin" and b["applicable"]:
        out += ["", f"黑绿线（{b['source']['name']}）：{b['text']}。只是读数，交易计划没用它（ADR 0022）"]
    out += ["",
            f"## 3) 看方向：抵扣价推演（未来 {PROJECT_DAYS} 天）", "",
            "| MA | 明天抵扣价 | 明天 MA 方向（价格不变） | 未来扣价均值 | 未来扣价最高 | 低于现价的天数 | 价格不变时 MA 变化 | 第几天首次扣到低于现价 |",
            "|---|---|---|---|---|---|---|---|"]
    for d in a["drops"]:
        first = f"第 {d['first_low']} 天" if d["first_low"] else f"{d['period']} 天内都不会"
        out.append(f"| {d['period']} | {d['tomorrow']:.2f} | {d['direction']} | {d['mean']:.2f} | {d['max']:.2f} | "
                   f"{d['below']}/{d['count']} | {d['ma_flat_change_pct']:+.2f}% | {first} |")
    out += ["",
            "读法：抵扣价低于现价 = 扣低值，股价不跌均线就上翘；高于现价 = 扣高值，股价要涨过它均线才不跌。",
            "“价格不变时 MA 变化”= 假设收盘价一直停在现价，推演期末 MA 相对今天的涨跌。",
            "", "## 4) 规则清单", "",
            "规则文字和来源见 references/rules.md。需看图的规则脚本算不了。", "",
            "| 编号 | 规则 | 状态 | 依据 | 价位 |", "|---|---|---|---|---|"]
    for x in a["rules"]:
        lv = "；".join(f"{k} {v:.2f}" for k, v in x["levels"].items())
        state = x["status"] + (f"，{x['yields_to']} 优先" if x["yields_to"] else "")
        out.append(f"| {x['id']} | {x['name']} | {state} | {x['basis']} | {lv} |")
    out += ["", "## 5) 对照：MA200 朴素规则", "", ma200_line(a["ma200"])]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("ticker", nargs="?", help="股票代码，如 TSLA（需要 yfinance）")
    p.add_argument("--csv", help="本地 CSV，含 Date, Close（Volume 可选）")
    p.add_argument("--asof", help="回放到某天，如 2021-04-14")
    p.add_argument("--source", choices=("auto", "polygon", "yfinance"), default="auto",
                   help="数据源：auto=先 Polygon 再 yfinance（默认）")
    p.add_argument("--env-file", help="含 POLYGON_API_KEY 的 .env 路径")
    p.add_argument("--no-hourly", action="store_true", help="不取小时线（P13 吃回撤④ 保持需看图）")
    p.add_argument("--html", help="另外生成网页报告到这个路径（.html）")
    p.add_argument("--commentary", help="点评 JSON（格式见 html_report.py），放进网页报告")
    p.add_argument("--chart-bars", type=int, default=None,
                   help="--json 的图表数据取最近多少根（默认和网页报告一样）；盲测练习要整段")
    p.add_argument("--account", type=float, help="账户规模（金额），用来算交易计划的股数")
    p.add_argument("--risk-pct", type=float, default=1.0, help="每笔可承受亏损占账户的百分比，默认 1")
    p.add_argument("--risk-amount", type=float, help="每笔可承受亏损的固定金额；给了就不用 --risk-pct")
    p.add_argument("--json", action="store_true",
                   help="改为输出 JSON：{analysis, chart}，给网页工作台和 agent 工具用")
    p.add_argument("--builtin-tones", action="store_true",
                   help="K 线着色只用自带规则，不读本机的着色插件（见 tones.py），黑绿线 P40–P45 因此需看图；盲测练习用，题目在每台机器上一样")
    a = p.parse_args()
    if not a.ticker and not a.csv:
        p.error("需要 ticker 或 --csv")
    if a.commentary and not a.html:
        p.error("--commentary 需要和 --html 一起用")
    for name in ("account", "risk_pct", "risk_amount"):
        v = getattr(a, name)
        if v is not None and not (math.isfinite(v) and v > 0):
            p.error(f"--{name.replace('_', '-')} 要是正数：{v}")
    sizing = tp.Sizing(account=a.account, risk_pct=a.risk_pct, risk_amount=a.risk_amount)
    df, history, src = load_prices(a.ticker, a.csv, a.asof, a.env_file, a.source)
    df = add_indicators(df)
    hourly = None
    if a.ticker and not a.no_hourly:
        hourly = load_hourly(a.ticker, a.asof, find_polygon_key(a.env_file), a.source, polygon_json)
    elif a.csv:
        hourly = {"available": False, "reason": "CSV 模式不取小时线"}
    earnings = ea.load_earnings(a.ticker.upper(), str(df.index[-1].date()), str(df.index[0].date())) if a.ticker else None
    result = analyze(df, a.ticker.upper() if a.ticker else a.csv, src, history, hourly, sizing, earnings,
                     tone_plugin=not a.builtin_tones)
    if a.json:
        from html_report import CHART_BARS, chart_data, weekly_chart

        chart = {**chart_data(df, result, a.chart_bars or CHART_BARS, a.builtin_tones),
                 "weekly": weekly_chart(history, result, a.builtin_tones)}
        print(json.dumps({"analysis": result, "chart": chart},
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
