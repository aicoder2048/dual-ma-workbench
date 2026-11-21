#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pandas",
#     "yfinance",
# ]
# ///
"""逐笔回测：每个交易日按当天的打法决定进不进、走不走，次日开盘成交，和买入持有、MA60 朴素基准比。

用法：
  uv run backtest.py                         # 默认 14 只票，2021-01-01 起
  uv run backtest.py NVDA INTC --from 2022-01-01 --jobs 8
  uv run backtest.py --fetch-only --history-from 2017-12-01 SPY   # 只取数（app 的 20 日回放也用这个）

- 行情：yfinance 复权日线（开高低收量），缓存在 --data/<票>.csv；覆盖不到所需历史、超过 7 天没更新、或 --refresh 就重取。
- 每天的分析：切出"当天往前 3 年"，调 dma_analyze.analyze，和 `dma_analyze.py --csv <同一段> --asof <那天>` 完全一样
  （tests/test_backtest.py 断言）。没有历史小时线，P13 一律"需看图"，按两种口径各跑一遍（trades.Chart）。
- 每天的结果缓存在 --out/daily/<票>.jsonl，脚本或行情变了自动重算。
- 报告写到 --out/<今天>.md，逐笔明细写到 --out/<今天>-trades.json，回测记录（按打法汇总，app 结论卡片读它）
  写到 --out/<今天>-record.json。`--record-from <明细.json>` 只从已有明细重算记录，不重跑分析。
  app 读的是提交进 skill 的 references/backtest-record.json，换一次回测就把新记录复制过去。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from pathlib import Path
from statistics import mean, median

import pandas as pd

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import dma_analyze as dma  # noqa: E402
import hourly as hr  # noqa: E402
import trades as tr  # noqa: E402
from indicators import add_indicators  # noqa: E402
from rules import RULES, Kind  # noqa: E402

PROJECT = SCRIPTS.parents[3]
WINNERS = ("NVDA", "TSLA", "AAPL", "GOOG", "META", "MSFT", "AMZN", "SPY", "QQQ")   # app 回放的默认 9 只
LOSERS = ("INTC", "PYPL", "NKE", "BA", "DIS")      # 2021 年以来大跌或长期落后的，抵消只挑赢家的偏差
OHLCV = ["Open", "High", "Low", "Close", "Volume"]
CSV_HOURLY = {"available": False, "reason": "CSV 模式不取小时线"}   # 和 dma_analyze.py --csv 一样
POLYGON_30M = "Polygon/Massive（30 分钟线合成）"   # 和 hourly.load_hourly 写的来源一样
HOURLY_CHUNK_DAYS = 30   # Polygon 每次最多 5 万根分钟线（30 分钟线按分钟线计），盘前盘后算上一天约 960 根
HORIZONS = (5, 20, 60)
FEW = 10                 # 日期数少于它的行标"日期少"
DAY = pd.Timedelta(days=1)


# ---------- 行情 ----------

def ensure_data(ticker: str, data: Path, need_from: pd.Timestamp, refresh: bool = False) -> Path:
    """缓存够用就直接用；否则从 need_from 取到昨天（只要已经收盘的日线）。"""
    path = data / f"{ticker}.csv"
    today = pd.Timestamp.today().normalize()
    if path.exists() and not refresh:
        df = load(path, check=False)
        if set(OHLCV) <= set(df.columns) and df.index[0] <= need_from + 7 * DAY and df.index[-1] >= today - 7 * DAY:
            return path
        print(f"{ticker}：缓存 {df.index[0].date()} ~ {df.index[-1].date()} 不够用，重新取", file=sys.stderr)
    import yfinance as yf

    df = yf.download(ticker, start=need_from.strftime("%Y-%m-%d"), end=today.strftime("%Y-%m-%d"),
                     auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    expect = int(len(pd.bdate_range(need_from, today)) * 0.9)
    if len(df) < expect or not set(OHLCV) <= set(df.columns):
        sys.exit(f"{ticker}：只取到 {len(df)} 根日线（至少要 {expect} 根），列 {list(df.columns)}")
    df = df[OHLCV].dropna()
    df.index.name = "Date"
    data.mkdir(parents=True, exist_ok=True)
    df.to_csv(path)
    return path


def load(path: Path, check: bool = True) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["Date"]).set_index("Date").sort_index()
    if check and not set(OHLCV) <= set(df.columns):
        raise ValueError(f"{path} 缺列：要 {OHLCV}，只有 {list(df.columns)}")
    return df


def ensure_hourly(ticker: str, data: Path, start: pd.Timestamp, refresh: bool = False) -> Path | None:
    """Polygon 30 分钟线，从 start 取到昨天，存 <票>-30m.csv。档位只给最近约 5 年，更早的部分取不到就跳过。

    没有 POLYGON_API_KEY 时返回 None：P13 一律需看图。
    """
    path = data / f"{ticker}-30m.csv"
    today = pd.Timestamp.today().normalize()
    if path.exists() and not refresh:
        got = pd.read_csv(path, parse_dates=["Date"])
        if len(got) and got["Date"].iloc[-1] >= today - 7 * DAY:
            return path
    key = dma.find_polygon_key(None)
    if not key:
        print(f"{ticker}：没有 POLYGON_API_KEY，P13 需看图", file=sys.stderr)
        return None
    parts, lo = [], start
    while lo < today:
        hi = min(lo + pd.Timedelta(days=HOURLY_CHUNK_DAYS - 1), today - DAY)
        try:
            parts.append(hr.fetch_polygon_30m(ticker, f"{lo.date()}", f"{hi.date()}", key, dma.polygon_json))
        except RuntimeError as exc:   # 档位外（403）或那段没有数据
            if "403" not in str(exc) and "没有小时数据" not in str(exc):
                raise
        lo = hi + DAY
    if not parts:
        return None
    df = pd.concat(parts)
    df = df[~df.index.duplicated()].sort_index()
    df.index.name = "Date"
    df.to_csv(path)
    return path


def hourly_at(bars30: pd.DataFrame | None, day: pd.Timestamp) -> dict:
    """某天收盘后的小时线结果，和 hourly.load_hourly(票, asof=那天) 用 Polygon 取到的一样：
    请求 [那天 − LOOKBACK_DAYS, 那天] 整天的 30 分钟线，再合成常规时段小时线。"""
    if bars30 is None:
        return {"available": False, "reason": "没有小时线数据"}
    lo = day - pd.Timedelta(days=hr.LOOKBACK_DAYS)
    got = bars30[(bars30.index >= lo) & (bars30.index < day + DAY)]
    if got.empty:
        return {"available": False, "reason": "Polygon：没有小时数据（早于档位窗口）"}
    return hr.hourly_json(hr.regular_hours(got), POLYGON_30M)


# ---------- 每天的分析 ----------

def history_at(px: pd.DataFrame, i: int) -> pd.DataFrame:
    """第 i 根当天往前 HISTORY_YEARS 年：那天实时取数能拿到的历史，周线用它。不含之后的任何一根，不够 5 年就用现有的。"""
    return dma.windows(px.iloc[:i + 1], px.index[i])[1]


def cut_at(px: pd.DataFrame, i: int) -> pd.DataFrame:
    """第 i 根当天往前 DAILY_YEARS 年：日线分析用的那段，不含之后的任何一根。"""
    end = px.index[i]
    cut = dma.windows(px.iloc[:i + 1], end)[0]
    if cut.index[0] > end - pd.DateOffset(years=dma.DAILY_YEARS) + 7 * DAY:
        raise ValueError(f"{end.date()}：历史从 {cut.index[0].date()} 起，不够 {dma.DAILY_YEARS} 年")
    return cut


def analyze_on(px: pd.DataFrame, i: int, label: str, hourly: dict | None = None, tone_plugin: bool = False) -> dict:
    """第 i 根收盘后的完整分析，等于 dma_analyze.py --csv <history_at 那段> --asof <那天> --builtin-tones 的 analysis。

    hourly 给了就代替 CSV 模式的"不取小时线"（hourly_at 的结果），只影响 P13 和用到它的 P14、打法文字。
    tone_plugin：照本机着色插件的颜色判黑绿线（P40–P45），等于不带 --builtin-tones。
    """
    cut = cut_at(px, i)
    a = dma.analyze(add_indicators(cut.copy()), label, f"CSV {label}", history_at(px, i), hourly or CSV_HOURLY,
                    tone_plugin=tone_plugin)
    if a["date"] != str(px.index[i].date()):
        raise AssertionError(f"{label}：分析日期 {a['date']} 不是决定日 {px.index[i].date()}")
    return a


def day_of(a: dict) -> tr.Day:
    return tr.Day(
        date=a["date"], key=a["play"]["key"], type=a["regime"]["type"], stage=a["regime"]["stage"],
        status={r["id"]: r["status"] for r in a["rules"]},
        yielded=frozenset(r["id"] for r in a["rules"] if r["yields_to"]),
        close=a["close"], ema20=next(x["ema"] for x in a["lines"] if x["period"] == 20),
        dirs=a["lean"]["dirs"], side20=a["steps"][0]["side"])


def _fingerprint(files: list[Path], start: str) -> str:
    h = hashlib.sha256((start + ",".join(tr.Day.__dataclass_fields__)).encode())
    for p in sorted(SCRIPTS.glob("*.py")):
        if p.name not in ("backtest.py", "trades.py", "html_report.py", "tones.py"):
            h.update(p.read_bytes())
    for f in files:
        h.update(f.read_bytes())
    return h.hexdigest()


def decide(job: tuple[str, str, str | None, str, str]) -> list[tr.Day]:
    """一只票从 start 起每个交易日的决定点；有对得上的缓存就读缓存。"""
    ticker, csv, h30, start, cache = job
    fp = _fingerprint([Path(csv)] + ([Path(h30)] if h30 else []), start)
    path = Path(cache)
    if path.exists():
        head, *rows = path.read_text().splitlines()
        if json.loads(head).get("fingerprint") == fp:
            return [tr.Day(**{**json.loads(r), "yielded": frozenset(json.loads(r)["yielded"])}) for r in rows]
    px = load(Path(csv))
    bars30 = pd.read_csv(h30, parse_dates=["Date"]).set_index("Date") if h30 else None
    first = px.index.searchsorted(pd.Timestamp(start))
    days = [day_of(analyze_on(px, i, ticker, hourly_at(bars30, px.index[i]))) for i in range(first, len(px))]
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"fingerprint": fp})]
    lines += [json.dumps({**asdict(d), "yielded": sorted(d.yielded)}, ensure_ascii=False) for d in days]
    path.write_text("\n".join(lines) + "\n")
    return days


# ---------- 汇总 ----------

def pc(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:+.1f}%"


def p0(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def trade_stats(ts: list[tr.Trade], base: dict[tuple[str, int], float | None]) -> dict:
    """一组交易的汇总（报告的一行、回测记录的一项）。ts 不能为空。"""
    rets = [t.ret for t in ts]
    ex = [float(t.ret - b) for t in ts if (b := base[(t.ticker, t.bars)]) is not None]
    ci = tr.bootstrap_ci(ex)
    return {"trades": len(ts), "dates": len({t.entry for t in ts}), "win_rate": sum(r > 0 for r in rets) / len(rets),
            "mean": mean(rets), "median": median(rets), "bars": mean(t.bars for t in ts), "mae": mean(t.mae for t in ts),
            "excess": mean(ex) if ex else None, "ci": list(ci) if ci else None}


def trade_row(name: str, ts: list[tr.Trade], base: dict[tuple[str, int], float | None]) -> str:
    if not ts:
        return f"| {name} | 0 | 0 | — | — | — | — | — | — | — |"
    s = trade_stats(ts, base)
    tag = "（日期少）" if s["dates"] < FEW else ""
    ci = s["ci"]
    return (f"| {name}{tag} | {s['trades']} | {s['dates']} | {p0(s['win_rate'])} | {pc(s['mean'])} | "
            f"{pc(s['median'])} | {s['bars']:.0f} | {pc(s['mae'])} | "
            f"{pc(s['excess'])} | {f'{pc(ci[0])} ~ {pc(ci[1])}' if ci else '—'} |")


# ---------- 回测记录：app 结论卡片上那一句，按打法 ----------

RECORD_CHART = tr.Chart.UNMET   # app 实盘有小时线：取保守口径，需看图当不满足


def baseline(series: dict[str, tuple[pd.DataFrame, int]], ts: list[tr.Trade]) -> dict[tuple[str, int], float | None]:
    """每笔对应的随机进场基准：同一只票、同一段时间、同样持有根数。"""
    return {(t.ticker, t.bars): tr.random_entry(*series[t.ticker], t.bars) for t in ts}


def build_record(series: dict[str, tuple[pd.DataFrame, int]], ts: list[tr.Trade], meta: dict) -> dict:
    """按打法（trades.SETUPS 的 key）汇总 RECORD_CHART 口径的交易。空仓不买的打法不在 setups 里，app 照实说不买；
    能买、但这段时间一笔没进的，trades 是 0。"""
    base = baseline(series, ts)
    setups = {}
    for s in tr.SETUPS:
        mine = [t for t in ts if t.setup == s.key]
        setups[s.key] = {"entries": list(s.entries), "trades": 0}
        if mine:
            st = trade_stats(mine, base)
            st["ci_crosses_zero"] = st["ci"] is None or st["ci"][0] <= 0 <= st["ci"][1]
            st["few_dates"] = st["dates"] < FEW   # 报告里标"日期少"的那种
            setups[s.key] = {"entries": list(s.entries), **st}
    return {"variant": RECORD_CHART.value, "source_report": meta["report"], "from": meta["from"], "to": meta["to"],
            "tickers": meta["tickers"], "generated": meta["generated"], "setups": setups}


def record_from(trades_json: Path, data: Path, start: str, tickers: list[str], report: str, generated: str) -> dict:
    """从一次回测的逐笔明细（<日期>-trades.json）和同一份行情缓存重算回测记录，不重跑分析。"""
    raw = json.loads(trades_json.read_text())[RECORD_CHART.value]
    ts = [tr.Trade(**t) for t in raw]
    series = {}
    for t in sorted(set(tickers) | {x.ticker for x in ts}):
        px = load(data / f"{t}.csv")
        series[t] = (px, int(px.index.searchsorted(pd.Timestamp(start))))
    first = min(px.index[i] for px, i in series.values())
    last = max(px.index[-1] for px, _ in series.values())
    meta = {"report": report, "from": str(first.date()), "to": str(last.date()), "tickers": tickers, "generated": generated}
    return build_record(series, ts, meta)


TRADE_HEAD = ("| 分组 | 笔数 | 进场日期数 | 胜率 | 平均 | 中位数 | 平均持有（根） | 平均最大回撤 | 比随机进场多 | 90% 区间 |\n"
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")


def account(px: pd.DataFrame, ts: list[tr.Trade], start: int) -> tuple[float, float, float]:
    """(总收益, 最大回撤, 在场时间占比)。"""
    eq = tr.curve(px, ts, start)
    return float(eq.iloc[-1] - 1), tr.max_drawdown(eq), tr.exposure(px, ts, start)


MIRRORED = {"P8", "P9", "P10", "P11", "P12", "P13", "P14"}
DOWN_TYPES = {"稳定下跌", "加速下跌"}
# 规则说的是买 / 持有，还是不买 / 离场（镜像一侧反过来）
SAYS = {"P2": "买", "P6": "买", "P14": "买", "P19": "买", "P20": "买", "P8": "持有", "P10": "条件", "P11": "条件",
        "P12": "条件", "P13": "条件", "P1": "不做", "P3": "离场", "P5": "离场", "P7": "不追", "P9": "等离场",
        "P16": "离场", "P17": "不买", "P18": "减仓"}
MIRROR_SAYS = {"P8": "持有空单", "P9": "等回补", "P14": "卖出"}


def rule_label(rid: str, day: tr.Day) -> str:
    return f"{rid} 镜像" if rid in MIRRORED and day.type in DOWN_TYPES else rid


def rule_stats(series: dict[str, tuple[pd.DataFrame, int, list[tr.Day]]]) -> list[str]:
    """每条动作规则"触发"（今天满足且没让位、昨天不是）之后 5 / 20 / 60 根的收益，减去同一只票所有天的平均。"""
    actions = [r.id for r in RULES if r.kind == Kind.ACTION and r.evaluate is not None]
    hits: dict[str, list[tuple[str, str, int]]] = defaultdict(list)
    base: dict[tuple[str, int], float] = {}
    for t, (px, start, days) in series.items():
        for h in HORIZONS:
            xs = [f for k in range(len(days)) if (f := tr.forward(px, start + k, h)) is not None]
            base[(t, h)] = mean(xs)
        prev: set[str] = set()
        for k, d in enumerate(days):
            now = set()
            for rid in actions:
                s = d.status[rid]
                if s == "满足" and rid not in d.yielded:
                    now.add(rule_label(rid, d))
                elif s == "需看图" and rid == "P14":
                    now.add(rule_label(rid, d) + "（需看图）")
            for lab in now - prev:
                hits[lab].append((t, d.date, start + k))
            prev = now
    order = {r: n for n, r in enumerate(actions)}
    rows = []
    for lab in sorted(hits, key=lambda x: (order[x.split()[0].split("（")[0]], x)):
        ev = hits[lab]
        rid = lab.split()[0].split("（")[0]
        says = MIRROR_SAYS.get(rid, SAYS.get(rid, "")) if "镜像" in lab else SAYS.get(rid, "")
        cells = []
        for h in (20, 60):
            fw = [(f, f - base[(t, h)]) for t, _, i in ev if (f := tr.forward(series[t][0], i, h)) is not None]
            cells += [pc(mean(f for f, _ in fw)) if fw else "—", pc(mean(e for _, e in fw)) if fw else "—",
                      p0(sum(f > 0 for f, _ in fw) / len(fw)) if fw else "—"]
        dates = len({d for _, d, _ in ev})
        tag = "（日期少）" if dates < FEW else ""
        rows.append(f"| {lab}{tag} | {says} | {len(ev)} | {dates} | " + " | ".join(cells) + " |")
    return rows


def p14_where(series: dict[str, tuple[pd.DataFrame, int, list[tr.Day]]]) -> str:
    """吃回撤（多头一侧）P14 算出满足的那些天，当天的打法是什么：只有打法是稳定上涨时，计划才会让人进场。"""
    keys = defaultdict(int)
    for _, _, days in series.values():
        for d in days:
            if d.status["P14"] == "满足" and d.type not in DOWN_TYPES:
                keys[f"{d.key}（{d.stage}）"] += 1
    if not keys:
        return "吃回撤（多头一侧）P14 一天都没有算出满足。"
    return ("吃回撤（多头一侧）P14 算出满足的日子按当天打法分：" + "，".join(f"{k} {v} 天" for k, v in keys.items())
            + "。打法不是稳定上涨的那些天，计划说的是别的（过渡是\"不做\"），所以不产生交易。")


def render(series, runs, holds, ma60s, chart_days, meta) -> str:
    out = [f"# 逐笔回测：{meta['from']} ~ {meta['to']}", ""]
    w = [t for t in meta["tickers"] if t in WINNERS]
    l_ = [t for t in meta["tickers"] if t not in WINNERS]
    out += [
        f"股票 {len(meta['tickers'])} 只：{' '.join(w)}（app 回放的默认 9 只，全是 2021 年以来的赢家）"
        + (f"；{' '.join(l_)}（同期大跌或长期落后，用来抵消只挑赢家的偏差）" if l_ else "") + "。",
        f"决定点：每只票每个交易日一次，共 {sum(len(d) for _, _, d in series.values())} 个。"
        "每天收盘后用当天往前 3 年的数据跑一遍分析（和 `dma_analyze.py --csv --asof` 完全一样，测试断言），"
        f"次日开盘成交，每边扣 {tr.COST * 100:.2f}%。只做多。数据：yfinance 复权日线。",
        "",
        "进场和离场（出处 `references/playbooks.md` 的空仓、持仓两列，代码在 `scripts/trades.py` 的 SETUPS）：",
        "",
        "| 当天打法 | 进场（任一满足） | 进场后离场（任一满足） |",
        "|---|---|---|",
        *[f"| {s.key} | {'、'.join(s.entries)}" + (f"（{'、'.join(s.blocked_by)} 满足时不进）" if s.blocked_by else "")
          + f" | {'、'.join(s.exits)} |" for s in tr.SETUPS],
        "",
        "其余打法（加速上涨、稳定下跌、加速下跌、空头结构反弹中、过渡）空仓时都是不买，没有进场。"
        "进场条件和离场条件同一天都成立时不进。P4（磨蹭就走）、P15（第一次回撤）脚本算不了，不参与。",
        "",
        f"**小时线（P13）**：Polygon 30 分钟线只回到约 {meta['hourly_from']}，之前的日子 P13 需看图（{chart_days['P13']} 个决定点），"
        f"其中 P14 因此需看图的 {chart_days['P14']} 个。三种口径各跑一遍：需看图当满足、需看图当不满足、"
        "不看小时线（P14 只看 P10–P12，量出吃回撤④ 过滤掉了什么）。"
        "对一个逐日决定的策略，\"跳过\"需看图的那天就是不进，和\"当不满足\"是同一个结果，所以不另列。",
        "",
    ]
    out += ["## 大盘背景", "", "| 年份 | SPY 涨跌 |", "|---|---:|"]
    spy = series.get("SPY")
    if spy:
        c = spy[0]["Close"]
        c = c[c.index >= pd.Timestamp(meta["from"]) - 10 * DAY]
        for y, g in c.groupby(c.index.year):
            prev = c[c.index.year < y]
            if len(prev):
                out.append(f"| {y}{'（到 ' + str(g.index[-1].date()) + '）' if y == c.index[-1].year else ''} | "
                           f"{pc(g.iloc[-1] / prev.iloc[-1] - 1)} |")
    out += ["", "2022 年是熊市（SPY 全年约 −18%，NVDA、META、TSLA 跌 50% 以上），其余年份大盘上涨。", ""]

    out += ["## 逐笔结果", "",
            "\"比随机进场多\"：每笔减去同一只票、同一段时间里随便哪天开盘买、拿同样根数的平均收益。"
            "它是\"进场时机有没有用\"的直接答案，不受这段时间大盘涨跌的影响。90% 区间是自助法，样本之间不独立（同一天几只票一起动），真实区间更宽。", ""]
    for chart, ts in runs.items():
        base = {(t.ticker, t.bars): tr.random_entry(series[t.ticker][0], series[t.ticker][1], t.bars) for t in ts}
        out += [f"### {chart.value}", "", TRADE_HEAD, trade_row("全部", ts, base)]
        for s in tr.SETUPS:
            for rule in s.entries:
                out.append(trade_row(f"{s.key} · {rule}", [t for t in ts if t.setup == s.key and t.rule == rule], base))
        out.append(trade_row("赢家 9 只", [t for t in ts if t.ticker in WINNERS], base))
        out.append(trade_row("落后 5 只", [t for t in ts if t.ticker not in WINNERS], base))
        for y in sorted({t.entry[:4] for t in ts}):
            out.append(trade_row(f"{y} 年进场", [t for t in ts if t.entry[:4] == y], base))
        reasons = defaultdict(int)
        for t in ts:
            reasons[t.reason] += 1
        out += ["", "离场原因：" + "，".join(f"{k} {v} 笔" for k, v in sorted(reasons.items(), key=lambda x: -x[1])) + "。", ""]

    out += ["## 资金曲线：和买入持有、MA60 基准比", "",
            "每只票单独一个账户，满仓进出，空仓时现金收益算 0。买入持有：第一天次日开盘买到最后。"
            "MA60 基准：收盘在 MA60 上方就买、跌到下方就卖（次日开盘）。", ""]
    head = ["| 票 | 买入持有 | 回撤 |"]
    sep = ["|---|---:|---:|"]
    for chart in runs:
        head.append(f" 规则（{chart.value}） | 回撤 | 在场 |")
        sep.append("---:|---:|---:|")
    head.append(" MA60 基准 | 回撤 | 在场 |")
    sep.append("---:|---:|---:|")
    out += ["".join(head), "".join(sep)]
    acc: dict[str, list[tuple[float, ...]]] = defaultdict(list)
    for t in meta["tickers"]:
        px, start, _ = series[t]
        row = [*account(px, [holds[t]], start)[:2]]
        for chart, ts in runs.items():
            row += account(px, [x for x in ts if x.ticker == t], start)
        row += account(px, ma60s[t], start)
        acc[t] = tuple(row)
        out.append(f"| {t} | " + " | ".join(p0(v) if k % 3 == 1 and k > 1 else pc(v) for k, v in enumerate(row)) + " |")
    for name, group in (("平均（全部）", meta["tickers"]), ("平均（赢家 9 只）", w), ("平均（落后 5 只）", l_)):
        if group:
            cols = list(zip(*(acc[t] for t in group)))
            out.append(f"| **{name}** | " + " | ".join(p0(mean(v)) if k % 3 == 1 and k > 1 else pc(mean(v))
                                                     for k, v in enumerate(cols)) + " |")
    out += ["", "\"在场\"是收盘时有仓位的天数占比。规则在场时间很短时，总收益低于买入持有是必然的；"
            "要看的是每笔的\"比随机进场多\"和回撤。", ""]

    out += ["## 按规则编号：触发之后", "",
            "触发 = 今天满足（没让位）、昨天不满足。收益从次日开盘算到 20 / 60 根后的开盘，不扣成本。"
            "\"超额\"减去同一只票这段时间所有天的平均，去掉了票本身的涨跌。"
            "\"说的是\"一栏：买 / 持有类的规则，超额为正才算有用；不买 / 离场类的，超额为负才算有用。"
            "镜像是下跌趋势里的那一侧（P14 镜像 = 反弹卖出）。", "",
            "| 规则 | 说的是 | 触发次数 | 日期数 | 20 根平均 | 20 根超额 | 20 根上涨占比 | 60 根平均 | 60 根超额 | 60 根上涨占比 |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
            *rule_stats(series), "", p14_where(series), ""]
    out += ["## 不能当真的地方", "",
            "- **只挑了赢家**：默认 9 只是事后看涨得最好的大盘股和指数。加了 5 只落后的，结论分开列；14 只仍然太少，也都是美国大盘股。",
            "- **样本不独立**：同一天几只票常常一起动，\"进场日期数\"比笔数更接近独立的几次。日期数少于 10 的行标\"日期少\"。",
            "- **一段时间、一种行情**：2021 年起不到 6 年，只有 2022 一次熊市。",
            "- **小时线不全**：2021 年到约 2022 年初没有小时线，那段 P13 需看图；三种口径的差就是它的影响范围。",
            "- **离场条件是解读**：rules.md 没给吃回撤和双线系统进场之后的底线，这里用 plan.ts 计划里写给用户的止损（见上表）。换一种解读结果会变；没有为了数字去调。",
            "- **复权价**：yfinance 复权价会用之后的分红、拆股回溯调整历史价，对涨跌幅和均线方向的影响可以忽略。",
            "- **成本**：每边 0.05%，没算税和融资。",
            "",
            "20 日涨跌表（和 2026-11-19 的报告同一格式）和改造前后对照在同目录的 `<日期>-20d.md`（app 的 `bun scripts/replay.ts --compare`）。",
            ""]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tickers", nargs="*", help=f"默认 {' '.join(WINNERS + LOSERS)}")
    p.add_argument("--from", dest="start", default="2021-01-01", help="第一个决定日（含），默认 2021-01-01")
    p.add_argument("--data", type=Path, default=PROJECT / "reports/replay/data", help="行情缓存目录")
    p.add_argument("--out", type=Path, default=PROJECT / "reports/replay", help="报告和每日缓存目录")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--refresh", action="store_true", help="重新取行情")
    p.add_argument("--fetch-only", action="store_true", help="只取日线，不回测")
    p.add_argument("--no-hourly", action="store_true", help="不取小时线（P13 一律需看图）")
    p.add_argument("--history-from", help="--fetch-only 时行情要从哪天起")
    p.add_argument("--record-from", type=Path, help="只从这份逐笔明细（<日期>-trades.json）和 --data 的行情重算回测记录，不重跑分析")
    p.add_argument("--report", help="--record-from 时记录里写的报告文件名，默认按明细文件名推")
    a = p.parse_args()
    tickers = [t.upper() for t in a.tickers] or list(WINNERS + LOSERS)
    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    if a.record_from:
        report = a.report or a.record_from.name.replace("-trades.json", ".md")
        rec = record_from(a.record_from, a.data, a.start, tickers, report, today)
        out = a.out / report.replace(".md", "-record.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n")
        print(f"回测记录：{out}", file=sys.stderr)
        return
    need = (pd.Timestamp(a.history_from) if a.history_from
            else pd.Timestamp(a.start) - pd.DateOffset(years=dma.HISTORY_YEARS) - 10 * DAY)
    csvs = {t: ensure_data(t, a.data, need, a.refresh) for t in tickers}
    if a.fetch_only:
        return
    h0 = pd.Timestamp(a.start) - pd.Timedelta(days=hr.LOOKBACK_DAYS)
    h30 = {t: None if a.no_hourly else ensure_hourly(t, a.data, h0, a.refresh) for t in tickers}
    jobs = [(t, str(csvs[t]), h30[t] and str(h30[t]), a.start, str(a.out / "daily" / f"{t}.jsonl")) for t in tickers]
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        all_days = dict(zip(tickers, ex.map(decide, jobs)))
    series = {}
    for t in tickers:
        px = load(csvs[t])
        series[t] = (px, px.index.get_loc(pd.Timestamp(all_days[t][0].date)), all_days[t])
    runs = {c: [x for t in tickers for x in tr.rule_trades(t, series[t][0], series[t][2], c)] for c in tr.Chart}
    holds = {t: tr.buy_hold(t, series[t][0], series[t][1]) for t in tickers}
    ma60s = {t: tr.ma60_trades(t, series[t][0], series[t][1]) for t in tickers}
    chart_days = {r: sum(d.status[r] == "需看图" for _, _, ds in series.values() for d in ds) for r in ("P13", "P14")}
    dates = sorted({d.date for _, _, ds in series.values() for d in ds})
    computed = [d.date for _, _, ds in series.values() for d in ds if d.status["P13"] != "需看图"]
    meta = {"tickers": tickers, "from": dates[0], "to": dates[-1], "hourly_from": min(computed) if computed else "（没有）"}
    md = render(series, runs, holds, ma60s, chart_days, meta)
    stamp = today
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"{stamp}.md").write_text(md)
    (a.out / f"{stamp}-trades.json").write_text(json.dumps(
        {c.value: [asdict(t) for t in ts] for c, ts in runs.items()}, ensure_ascii=False, indent=1))
    rec = build_record({t: series[t][:2] for t in tickers}, runs[RECORD_CHART],
                       {**meta, "report": f"{stamp}.md", "generated": stamp})
    (a.out / f"{stamp}-record.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n")
    print(md)
    print(f"报告：{a.out / f'{stamp}.md'}", file=sys.stderr)


if __name__ == "__main__":
    main()
