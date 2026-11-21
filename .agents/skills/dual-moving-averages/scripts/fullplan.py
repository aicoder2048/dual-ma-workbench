#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
#     "yfinance",
# ]
# ///
"""完整计划逐笔回测：照结论卡片的交易计划下单（进场触发价、止损、第一目标、按风险算股数），结果怎样。

用法：
  uv run fullplan.py                         # 2026-11-20 评估的全部品种（开发集 + 旧验证集）
  uv run fullplan.py --tickers SPY,NVDA,INTC --jobs 3

- 品种、行情、决定点范围和 evaluate.py 一样（reports/replay/eval/universe-<snapshot>.json、data/eval/）。
- 每天收盘后的交易计划走轻量路径（只算计划要的：类型、结构、周线、tradeplan.build、失效条件），
  每 CHECK_EVERY 天和完整分析（backtest.analyze_on，等于 dma_analyze.py --csv --asof）对一次，不一样就停。
- 成交、仓位、指标的规则在 plansim.py。
- 每只票每天的计划缓存在 <out>/fullplan/daily/<票>.jsonl，规则代码或行情变了自动重算。
- 报告：<out>/<snapshot 次日>-fullplan-dev.md 和 .json。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import backtest as bt  # noqa: E402
import dma_analyze as dma  # noqa: E402
import evalstats as es  # noqa: E402
import evaluate as ev  # noqa: E402
import plansim as ps  # noqa: E402
import regime as rg  # noqa: E402
import rules as rl  # noqa: E402
import tradeplan as tp  # noqa: E402
import trades as tr  # noqa: E402
from indicators import PERIODS, add_indicators  # noqa: E402
from structure import find_structure  # noqa: E402
from weekly import weekly_json  # noqa: E402

PROJECT = SCRIPTS.parents[3]
VERSION = "1"            # 指纹不含本文件：改了 light_plan 或 _record 要加一，缓存才会重算
CHUNK = 250
CHECK_EVERY = 20         # 每 20 个决定点和完整分析对一次
# 计划里能用到的失效条件（trades.DERIVED 和 P3、P5），每天记下哪几条成立
EXIT_NAMES = ("P3", "P5", *tr.DERIVED)


# ---------- 每天的计划 ----------

def _exits(day: tr.Day) -> list[str]:
    return [x for x in EXIT_NAMES if tr.check(day, x, tr.Chart.UNMET)[0]]


def _record(i: int, d: str, plan: dict, exits: list[str]) -> dict:
    """计划 JSON 里回测要用的部分：空仓的进场、止损、目标、盈亏比，和当天成立的失效条件。"""
    f = plan["flat"]
    targets = [t["price"] for t in f["targets"]]
    return {"i": i, "d": d, "key": plan["key"],
            "entry": f["entry"]["price"] if f["entry"] else None, "rule": f["entry"]["rule"] if f["entry"] else None,
            "stop": f["stop"]["price"] if f["stop"] else None,
            "t1": targets[0] if targets else None, "t2": targets[1] if len(targets) > 1 else None,
            "rr": f["rr"], "verdict": f["rr_verdict"], "x": exits}


def light_plan(cut: pd.DataFrame, history: pd.DataFrame) -> tuple[dict, list[str]]:
    """轻量路径：dma_analyze.analyze 里交易计划用到的那几步（同样的顺序、同样的输入），加上失效条件。

    返回 (trade_plan JSON, 当天成立的失效条件)。不跑推演表、模糊判断、规则清单。
    """
    df = add_indicators(cut.copy())
    row = df.iloc[-1]
    c = float(row["Close"])
    bias = df["BIAS20"].dropna()
    structure = find_structure(df)
    regime, p20 = rg.classify(df, structure, float((bias <= row["BIAS20"]).mean()))
    ctx = rl.Ctx(df=df, regime=regime, p20=p20, p60=rg.pair_progress(df, 60, 120), structure=structure,
                 weekly=weekly_json(history), hourly=bt.CSV_HOURLY)
    plan = json.loads(json.dumps(tp.plan_json(tp.build(ctx)), ensure_ascii=False))
    values = {f"{k}{n}": float(row[f"{k}{n}"]) for n in PERIODS for k in ("MA", "EMA")}
    slopes = {f"{k}{n}": dma.slope_pct(df[f"{k}{n}"]) for n in PERIODS for k in ("MA", "EMA")}
    status = {"P3": rl.p3_ambush_stop(ctx).status.value, "P5": rl.p5_fake_breakout(ctx).status.value}
    day = tr.Day(date=str(df.index[-1].date()), key=plan["key"], type=None, stage=None, status=status,
                 yielded=frozenset(), close=c, ema20=float(row["EMA20"]), dirs=dma.line_votes(values, slopes, c)["dirs"],
                 side20=p20.side)
    return plan, _exits(day)


def plan_day(px: pd.DataFrame, i: int, ticker: str, check: bool) -> dict:
    cut = bt.cut_at(px, i)
    if cut.index[-1] != px.index[i] or len(cut) > i + 1:
        raise AssertionError(f"{ticker} {px.index[i].date()}：计划用到了之后的行情")
    plan, exits = light_plan(cut, bt.history_at(px, i))
    if check:
        a = bt.analyze_on(px, i, ticker)
        full = json.loads(json.dumps(a["trade_plan"], ensure_ascii=False))
        if full != plan:
            raise AssertionError(f"{ticker} {px.index[i].date()}：轻量路径的交易计划和完整分析不一致")
        if _exits(bt.day_of(a)) != exits:
            raise AssertionError(f"{ticker} {px.index[i].date()}：轻量路径的失效条件和完整分析不一致")
    return _record(i, str(px.index[i].date()), plan, exits)


def run_chunk(job: tuple[str, str, int, int, int]) -> tuple[str, int, list[dict]]:
    ticker, csv, lo, hi, first = job
    px, _ = ev.load_prices(Path(csv))
    return ticker, lo, [plan_day(px, i, ticker, (i - first) % CHECK_EVERY == 0) for i in range(lo, hi)]


# 不影响每天计划的脚本：改了它们缓存照用
NOT_RULES = ("fullplan.py", "plansim.py", "planrun.py", "evaluate.py", "evalstats.py", "backtest.py", "html_report.py")


def fingerprint(csv: Path, cfg: dict) -> str:
    h = hashlib.sha256(f"{VERSION},{cfg['sample']['first_decision']}".encode())
    for p in sorted(SCRIPTS.glob("*.py")):
        if p.name not in NOT_RULES:
            h.update(p.read_bytes())
    h.update(csv.read_bytes())
    return h.hexdigest()


def cache_file(out: Path, ticker: str) -> Path:
    return out / "fullplan" / "daily" / f"{ticker}.jsonl"


def is_cached(path: Path, fp: str) -> bool:
    """缓存的第一行是指纹；只读这一行。"""
    if not path.exists():
        return False
    with path.open() as f:
        return json.loads(f.readline() or "{}").get("fingerprint") == fp


def daily(tickers: list[str], data: Path, out: Path, cfg: dict, jobs: int,
          progress: Callable[[int, int, str], None] | None = None) -> dict[str, list[dict]]:
    """每只票每个决定点的计划；缓存对得上就读缓存，否则切块并行算。progress(做完几块, 共几块, 说明) 每做完一块调一次。"""
    got, todo, fps, need = {}, [], {}, defaultdict(int)
    for t in tickers:
        csv = data / f"{t}.csv"
        fps[t] = fingerprint(csv, cfg)
        path = cache_file(out, t)
        if is_cached(path, fps[t]):
            got[t] = [json.loads(r) for r in path.read_text().splitlines()[1:]]
            continue
        px, _ = ev.load_prices(csv)
        first = ev.first_index(px, cfg)
        for lo in range(first, len(px), CHUNK):
            todo.append((t, str(csv), lo, min(lo + CHUNK, len(px)), first))
            need[t] += 1
    if not todo:
        return got
    parts: dict[str, dict[int, list[dict]]] = defaultdict(dict)
    t0 = time.time()
    print(f"计划 {len(need)} 只票，{len(todo)} 块，{jobs} 个进程", file=sys.stderr)
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(run_chunk, j) for j in todo]
        for n, f in enumerate(as_completed(futs), 1):
            t, lo, rows = f.result()
            parts[t][lo] = rows
            note = f"{t} 第 {len(parts[t])}/{need[t]} 块"
            if len(parts[t]) == need[t]:
                recs = [r for k in sorted(parts[t]) for r in parts[t][k]]
                path = cache_file(out, t)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")       # 先写临时文件再改名：中途被停掉不留半个缓存
                tmp.write_text("\n".join([json.dumps({"fingerprint": fps[t]})] + [json.dumps(r, ensure_ascii=False) for r in recs]) + "\n")
                tmp.replace(path)
                got[t] = recs
                note = f"{t} 完成（{len(recs)} 天）"
                print(f"  {note}，{n}/{len(todo)} 块，{time.time() - t0:.0f}s", file=sys.stderr)
            if progress:
                progress(n, len(todo), note)
    return got


# ---------- 行情摆到同一个日历上 ----------

def load_bars(tickers: list[str], data: Path) -> tuple[list[str], dict[str, ps.Bars], dict[str, pd.DataFrame]]:
    """(全局日历, 每只票对齐到日历的行情, 每只票自己的拆股复权行情)。"""
    raw = {t: ev.load_prices(data / f"{t}.csv") for t in tickers}
    cal_idx = sorted(set().union(*(df.index for df, _ in raw.values())))
    cal = [str(d.date()) for d in cal_idx]
    bars = {}
    for t, (sig, ret) in raw.items():
        s = sig.reindex(cal_idx)
        f = (ret["Close"] / sig["Close"]).reindex(cal_idx)
        bars[t] = ps.Bars(*(s[k].to_numpy(dtype=float) for k in ("Open", "High", "Low", "Close")), f.to_numpy(dtype=float))
    return cal, bars, {t: sig for t, (sig, _) in raw.items()}


# ---------- 计划 → 单 ----------

# 加速下跌的进场是 20 线组拐头（tradeplan._turn20，和多头结构回撤中同一个止损原则），失效用同一条；
# 20/60 本来就在空头一边，J16 双死叉不适用
TURN20_EXITS = ("EMA20 止损",)


def invalidation(key: str) -> tuple[str, ...]:
    """打法的失效条件：trades.SETUPS 里每套打法进场后的离场条件（出处 playbooks.md、plan.ts）。"""
    return tr.BY_KEY[key].exits if key in tr.BY_KEY else TURN20_EXITS


# 进场价只是中途的一步、之后还有条件的（P11：回撤到 60 线组，之后还要底部构造、小时线多头排列）：卡片没让人在这个价买
WAYPOINT = frozenset({"P11"})
# 触发之后还要小时线多头排列的（P12：底部构造完成再加小时线；P13：只差小时线）。CSV 回放没有小时线
NEEDS_HOURLY = frozenset({"P12", "P13"})


@dataclass(frozen=True)
class Variant:
    name: str
    rr_filter: bool = True          # 盈亏比不到 3:1（或算不了）不做
    targets: bool = True            # 第一目标离场
    equal_notional: bool = False    # 不按风险算股数：每笔同样金额
    skip_hourly: bool = False       # 还要看小时线的进场不做（小时线当不满足）
    waypoint: bool = False          # P11 的回撤价也当限价单买
    intraday_stop: bool = False     # 止损看盘中最低价（PR #42 的口径），不按收盘
    position_cap: bool = True       # 单票持仓金额上限（evaluation.toml 的 fullplan.max_position）


FULL = Variant("完整计划")
ABLATIONS = (Variant("关盈亏比过滤", rr_filter=False), Variant("关目标（拿到止损或失效）", targets=False),
             Variant("关仓位（每笔等金额）", equal_notional=True))
EXTRA = (Variant("要看小时线的不进", skip_hourly=True), Variant("回撤到 60 线组就买（P11）", waypoint=True),
         Variant("止损看盘中最低价", intraday_stop=True), Variant("不设单票仓位上限", position_cap=False),
         Variant("PR #42 口径（盘中止损、不设上限）", intraday_stop=True, position_cap=False))
VARIANTS = (FULL, *ABLATIONS, *EXTRA)


def orders_for(recs: dict[str, list[dict]], pos: dict[str, int], bars: dict[str, ps.Bars], v: Variant,
               atrs: dict[str, np.ndarray] | None = None) -> dict[int, list[ps.Order]]:
    """atrs[票][全局日历位置]：信号日的 ATR(14)，给了就带在单上（止损下限用）。"""
    out: dict[int, list[ps.Order]] = defaultdict(list)
    for t, rs in recs.items():
        for r in rs:
            entry, stop = r["entry"], r["stop"]
            if entry is None or stop is None or entry - stop < tp.TICK:
                continue
            if v.rr_filter and r["verdict"] not in ("可做", "理想"):
                continue
            if (r["rule"] in WAYPOINT and not v.waypoint) or (v.skip_hourly and r["rule"] in NEEDS_HOURLY):
                continue
            g = pos[r["d"]]
            target = r["t1"] if v.targets and r["t1"] is not None and r["t1"] > entry else None
            out[g].append(ps.Order(t, g, ps.entry_kind(entry, bars[t].c[g]), entry, stop, target, invalidation(r["key"]),
                                   key=r["key"], rule=r["rule"], rr=r["rr"], atr=None if atrs is None else float(atrs[t][g])))
    return out


def inval_for(recs: dict[str, list[dict]], pos: dict[str, int], n: int) -> dict[str, list[frozenset[str]]]:
    out = {}
    for t, rs in recs.items():
        x = [frozenset()] * n
        for r in rs:
            x[pos[r["d"]]] = frozenset(r["x"])
        out[t] = x
    return out


def random_orders(real: list[ps.Trade], recs: dict[str, list[dict]], pos: dict[str, int], bars: dict[str, ps.Bars],
                  rng: np.random.Generator) -> dict[int, list[ps.Order]]:
    """同样的仓位和离场，随机进场：每笔真实交易换成同一只票随便一天收盘后的开盘买入，止损、目标离进场的距离（%）照抄，
    最多拿那笔真实交易的根数（代替失效离场）。"""
    out: dict[int, list[ps.Order]] = defaultdict(list)
    days = {t: [pos[r["d"]] for r in rs] for t, rs in recs.items()}
    for x in real:
        g = int(rng.choice(days[x.ticker][:-1]))
        c = bars[x.ticker].c[g]
        stop = c * x.stop / x.plan_entry
        target = None if x.target is None else c * x.target / x.plan_entry
        out[g].append(ps.Order(x.ticker, g, ps.Kind.OPEN, c, stop, target, (), max(1, x.exit_i - x.entry_i),
                               key="随机", rule="随机"))
    return out


# ---------- 汇总 ----------

def summarize(res: ps.Result, cal: list[str], bc: dict) -> dict:
    rs = np.array([t.r for t in res.trades])
    eq = res.equity
    mdd = ps.max_drawdown(eq)
    out = {"trades": len(rs), "cagr": ps.cagr(eq), "mdd": mdd, "mar": ps.cagr(eq) / abs(mdd) if mdd < 0 else None,
           "exposure": float((res.invested > 0).mean()), "invested": float(res.invested.mean()),
           "streak": ps.longest_losing_streak(res.trades),
           "reasons": dict(Counter(t.reason.split("：")[0] for t in res.trades)), "skipped": res.skipped,
           "mean_r": None, "ci": None, "blocks": 0, "win": None, "payoff": None}
    if len(rs):
        est = es.mean_est(rs, es.block_ids([cal[t.entry_i] for t in res.trades], cal, bc["block_days"]), bc)
        out.update(mean_r=est.point, ci=None if est.lo is None else [est.lo, est.hi], blocks=est.blocks,
                   win=float((rs > 0).mean()), payoff=ps.payoff(rs))
    return out


def sleeve(sig: pd.DataFrame, f: np.ndarray, rule: int | None, first: str, cal: list[str], start: int,
           cost: float) -> tuple[np.ndarray, float]:
    """一只票的朴素基准，满仓进出（evalstats.equity，含分红），摆到全局日历上：开始之前是 1，没有行情的日子照前一天。"""
    o = sig["Open"].to_numpy() * f
    c = sig["Close"].to_numpy() * f
    s = int(sig.index.searchsorted(pd.Timestamp(first)))
    close = sig["Close"].to_numpy()
    mask = (np.ones(len(sig), dtype=bool) if rule is None
            else close > pd.Series(close).rolling(rule).mean().to_numpy())[s:len(sig) - 1]
    eq = es.equity(o, c, mask, s, cost)
    curve = pd.Series(np.concatenate([[1.0], eq]), index=[str(d.date()) for d in sig.index[s:]])
    return curve.reindex(cal[start:]).ffill().fillna(1.0).to_numpy(), float(mask.mean())


BASELINES = (("买入持有", None), ("MA200 朴素规则", 200), ("MA60 朴素规则", 60))


def basket(tickers: list[str], sigs: dict[str, pd.DataFrame], bars: dict[str, ps.Bars], firsts: dict[str, str],
           cal: list[str], start: int, cost: float, rule: int | None) -> tuple[np.ndarray, float]:
    """每只票分一样多的钱，各自照规则满仓进出，不再平衡：(组合净值 = 各只净值的平均, 平均在场比例)。"""
    pos = {d: k for k, d in enumerate(cal)}
    curves, exp = [], []
    for t in tickers:
        f = bars[t].f[[pos[str(d.date())] for d in sigs[t].index]]
        cv, e = sleeve(sigs[t], f, rule, firsts[t], cal, start, cost)
        curves.append(cv)
        exp.append(e)
    return np.mean(curves, axis=0), float(np.mean(exp))


def curve_stats(eq: np.ndarray, exposure: float) -> dict:
    mdd = ps.max_drawdown(eq)
    return {"cagr": ps.cagr(eq), "mdd": mdd, "mar": ps.cagr(eq) / abs(mdd) if mdd < 0 else None, "exposure": exposure}


def baselines(tickers: list[str], sigs: dict[str, pd.DataFrame], bars: dict[str, ps.Bars], firsts: dict[str, str],
              cal: list[str], start: int, cost: float) -> dict[str, dict]:
    return {name: curve_stats(*basket(tickers, sigs, bars, firsts, cal, start, cost, rule)) for name, rule in BASELINES}


# ---------- 诊断：止损离进场几个 ATR ----------

ATR_N = 14


def atr(df: pd.DataFrame, n: int = ATR_N) -> pd.Series:
    """Wilder 的平均真实波幅：真实波幅 = 最高、最低、前收三者里最大的差，按 1/n 指数平均。只用当天和之前的行情。"""
    prev = df["Close"].shift()
    tr = pd.concat([df["High"] - df["Low"], (df["High"] - prev).abs(), (df["Low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


# ---------- 一组品种一个账户 ----------

GROUPS = (("合并（A+B+C）", ("A", "B", "C")), ("A ETF", ("A",)), ("B+C 个股", ("B", "C")), ("B 科技和 AI", ("B",)),
          ("C 其他大市值", ("C",)), ("D 曾经的巨头", ("D",)))
# 用户的核心名单：先测它，过了关再补测其余品种
CORE = ("SPY QQQ SMH SOXX XLK AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO AMD ORCL TSM PLTR NFLX CRM ADBE ASML MU ANET CRWD "
        "PANW AMAT LRCX TXN IBM CSCO SAP JPM V MA LLY COST WMT BRK-B").split()


def gate(g: dict) -> tuple[bool, list[str]]:
    """核心名单的关口：完整计划的平均 R 90% 区间整个在 0 以上，而且 MAR 不低于同一批品种上的 MA200 朴素规则。"""
    full, ma200 = g["runs"][FULL.name], g["baselines"]["MA200 朴素规则"]
    why = []
    if full["ci"] is None or full["ci"][0] <= 0:
        why.append("平均 R 的 90% 区间" + ("算不出" if full["ci"] is None else
                                       f"是 {full['ci'][0]:+.2f} ~ {full['ci'][1]:+.2f}，{'跨 0' if full['ci'][1] > 0 else '整个在 0 以下'}"))
    if full["mar"] is None or ma200["mar"] is None or full["mar"] < ma200["mar"]:
        why.append(f"MAR {f2(full['mar'])} 低于 MA200 朴素规则的 {f2(ma200['mar'])}")
    return not why, why
POOLED = GROUPS[0][0]
RANDOM_REPS = 20
RANDOM_SEED = 11
HALF = "2019-12-31"


def _random_summary(reps: list[dict]) -> dict:
    def q(k: str, p: float) -> float | None:
        xs = [r[k] for r in reps if r[k] is not None]
        return float(np.percentile(xs, p)) if xs else None
    return {"reps": len(reps), **{k: q(k, 50) for k in ("trades", "mean_r", "win", "payoff", "cagr", "mdd", "mar", "exposure",
                                                        "invested", "streak")},
            "mean_r_5": q("mean_r", 5), "mean_r_95": q("mean_r", 95), "mar_5": q("mar", 5), "mar_95": q("mar", 95)}


def run_group(job: tuple) -> tuple[str, dict]:
    name, tickers, recs, cal, bars, sigs, bc, cost, max_position = job
    pos = {d: k for k, d in enumerate(cal)}
    inval = inval_for(recs, pos, len(cal))
    start = min(pos[rs[0]["d"]] for rs in recs.values())
    runs, trades = {}, {}

    def go(v: Variant, notional_pct: float | None = None) -> None:
        cfg = ps.Config(cost=cost, notional_pct=notional_pct, stop_on_close=not v.intraday_stop,
                        max_position=max_position if v.position_cap else None)
        res = ps.simulate(len(cal), bars, orders_for(recs, pos, bars, v), inval, start, cfg)
        runs[v.name], trades[v.name] = summarize(res, cal, bc), res.trades

    for v in VARIANTS:
        if not v.equal_notional:
            go(v)
    full = trades[FULL.name]
    notional = float(np.mean([t.notional for t in full])) if full else 0.1
    for v in VARIANTS:
        if v.equal_notional:
            go(v, notional)
    rng = np.random.default_rng(RANDOM_SEED)
    rand = [summarize(ps.simulate(len(cal), bars, random_orders(full, recs, pos, bars, rng), inval, start,
                                  ps.Config(cost=cost, max_position=max_position)),
                      cal, bc) for _ in range(RANDOM_REPS)] if full else []
    halves = {}
    for label, keep in (("2013–2019", lambda d: d <= HALF), ("2020–2026", lambda d: d > HALF)):
        part = [t for t in full if keep(cal[t.entry_i])]
        rs = np.array([t.r for t in part])
        est = es.mean_est(rs, es.block_ids([cal[t.entry_i] for t in part], cal, bc["block_days"]), bc) if len(rs) else None
        halves[label] = {"trades": len(rs), "mean_r": est.point if est else None,
                         "ci": None if est is None or est.lo is None else [est.lo, est.hi]}
    firsts = {t: rs[0]["d"] for t, rs in recs.items()}
    atrs = {t: atr(sigs[t]) for t in recs}
    return name, {"tickers": sorted(recs), "start": cal[start], "end": cal[-1], "notional": notional, "runs": runs,
                  "random": _random_summary(rand) if rand else None, "halves": halves,
                  "baselines": baselines(sorted(recs), sigs, bars, firsts, cal, start, cost),
                  "trades": [{**asdict(t), "signal_date": cal[t.signal], "entry_date": cal[t.entry_i],
                              "exit_date": cal[t.exit_i], "atr": float(atrs[t.ticker][pd.Timestamp(cal[t.signal])])}
                             for t in full]}


# ---------- 和结论卡片对一遍 ----------

def card_check(trades: list[dict], sigs: dict[str, pd.DataFrame], n: int = 5, seed: int = 3) -> list[dict]:
    """抽几笔交易，用 dma_analyze.py --csv --asof（结论卡片的数据）重算信号日的计划，进场、止损、第一目标、盈亏比结论要一样。"""
    rng = np.random.default_rng(seed)
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for k in sorted(rng.choice(len(trades), min(n, len(trades)), replace=False)):
            t = trades[k]
            sig = sigs[t["ticker"]]
            i = sig.index.get_loc(pd.Timestamp(t["signal_date"]))
            csv = Path(tmp) / f"{t['ticker']}.csv"
            bt.history_at(sig, i).to_csv(csv)
            proc = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(csv), "--asof",
                                   t["signal_date"], "--json"], capture_output=True, text=True, check=True)
            f = json.loads(proc.stdout)["analysis"]["trade_plan"]["flat"]
            card = {"entry": f["entry"]["price"], "stop": f["stop"]["price"], "t1": f["targets"][0]["price"],
                    "verdict": f["rr_verdict"], "condition": f["entry"]["condition"]}
            nxt = sig.iloc[i + 1]
            same = (abs(card["entry"] - t["plan_entry"]) < 1e-9 and abs(card["stop"] - t["stop"]) < 1e-9
                    and abs(card["t1"] - t["target"]) < 1e-9 and card["verdict"] in ("可做", "理想"))
            out.append({"trade": t, "card": card, "next_bar": {k2: float(nxt[k2]) for k2 in ("Open", "High", "Low", "Close")},
                        "same": bool(same)})
    return out


# ---------- 报告 ----------

def pc(x: float | None, d: int = 1) -> str:
    return "—" if x is None else f"{x * 100:+.{d}f}%"


def p0(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def f2(x: float | None) -> str:
    return "—" if x is None else f"{x:.2f}"


def rr_cell(s: dict) -> str:
    if s["mean_r"] is None:
        return "—"
    ci = "区间 —" if s["ci"] is None else f"{s['ci'][0]:+.2f} ~ {s['ci'][1]:+.2f}"
    return f"{s['mean_r']:+.2f}（{ci}）"


HEAD = ("| 做法 | 笔数 | 平均 R（90% 区间） | 胜率 | 赔率 | 年化 | 最大回撤 | MAR | 有持仓的天数 | 平均仓位 | 最长连亏 |\n"
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")


def run_row(name: str, s: dict) -> str:
    return (f"| {name} | {s['trades']} | {rr_cell(s)} | {p0(s['win'])} | {f2(s['payoff'])} | {pc(s['cagr'])} | "
            f"{pc(s['mdd'])} | {f2(s['mar'])} | {p0(s['exposure'])} | {p0(s['invested'])} | {s['streak']} |")


def random_row(r: dict | None) -> str:
    if not r:
        return "| 随机进场（同仓位、同离场） | — | — | — | — | — | — | — | — | — | — |"
    rr = "—" if r["mean_r"] is None else f"{r['mean_r']:+.2f}（{r['mean_r_5']:+.2f} ~ {r['mean_r_95']:+.2f}）"
    return (f"| 随机进场（同仓位、同离场，{r['reps']} 次的中位数） | {r['trades']:.0f} | {rr} | {p0(r['win'])} | {f2(r['payoff'])} | "
            f"{pc(r['cagr'])} | {pc(r['mdd'])} | {f2(r['mar'])}（{f2(r['mar_5'])} ~ {f2(r['mar_95'])}） | {p0(r['exposure'])} | "
            f"{p0(r['invested'])} | {r['streak']:.0f} |")


def base_row(name: str, b: dict) -> str:
    return f"| {name}（不按仓位，在场就满仓） | — | — | — | — | {pc(b['cagr'])} | {pc(b['mdd'])} | {f2(b['mar'])} | {p0(b['exposure'])} | — | — |"


def group_table(g: dict) -> list[str]:
    rows = [HEAD, *[run_row(f"**{n}**" if n == FULL.name else n, g["runs"][n]) for n in [v.name for v in VARIANTS]],
            random_row(g["random"]), *[base_row(n, g["baselines"][n]) for n, _ in BASELINES]]
    return rows


def trade_line(t: dict) -> str:
    tgt = "—" if t["target"] is None else f"{t['target']:.2f}"
    return (f"| {t['ticker']} | {t['signal_date']} | {t['key']} · {t['rule']} | {t['kind']} | {t['plan_entry']:.2f} / {t['fill']:.2f} | "
            f"{t['stop']:.2f} | {tgt} | {t['exit_date']} {t['reason']} @ {t['exit_px']:.2f} | {t['r']:+.2f} |")


STOP_BUCKETS = ((0, 0.005), (0.005, 0.01), (0.01, 0.02), (0.02, 0.05), (0.05, 1.0))
ATR_BUCKETS = ((0, 0.25), (0.25, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, float("inf")))
V1 = "PR #42 口径（盘中止损、不设上限）"


def bucket_rows(ts: list[dict], dist: np.ndarray, buckets, label) -> list[str]:
    """按止损距离分档：笔数、平均 R、中位 R、每笔平均盈亏占净值、胜率、止损走的占比、计划盈亏比。"""
    rs = np.array([t["r"] for t in ts])
    eq = np.array([equity_pnl(t) for t in ts])
    out = []
    for lo, hi in buckets:
        m = (dist >= lo) & (dist < hi)
        if not m.any():
            continue
        rr = [t["rr"] for t, keep in zip(ts, m) if keep and t["rr"] is not None]
        stopped = np.mean([t["reason"] == "止损" for t, keep in zip(ts, m) if keep])
        out.append(f"| {label(lo, hi)} | {int(m.sum())} | {rs[m].mean():+.2f} | {np.median(rs[m]):+.2f} | {pc(float(eq[m].mean()), 2)} | "
                   f"{p0(float((rs[m] > 0).mean()))} | {p0(float(stopped))} | {np.mean(rr):.1f} |")
    return out


BUCKET_HEAD = ("| 止损距离 | 笔数 | 平均 R | 中位 R | 每笔盈亏占净值 | 胜率 | 止损走的 | 平均盈亏比（计划） |\n"
               "|---|---:|---:|---:|---:|---:|---:|---:|")


def before_after(groups: dict[str, dict], before: dict) -> list[str]:
    """和上一版报告（PR #42）的完整计划逐组对照；再核一遍"PR #42 口径"这一行是不是逐项复现了上一版。"""
    out = ["| 组 | 版本 | 笔数 | 平均 R（90% 区间） | 胜率 | 年化 | 最大回撤 | MAR | MA200 的 MAR |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    same = []
    for gname, g in groups.items():
        old = before["groups"].get(gname)
        if old is None:
            continue
        ma = f2(g["baselines"]["MA200 朴素规则"]["mar"])
        for label, s in (("PR #42", old["runs"][FULL.name]), ("这一版", g["runs"][FULL.name])):
            out.append(f"| {gname} | {label} | {s['trades']} | {rr_cell(s)} | {p0(s['win'])} | {pc(s['cagr'])} | {pc(s['mdd'])} | "
                       f"{f2(s['mar'])} | {ma} |")
        rep, o = g["runs"][V1], old["runs"][FULL.name]
        same.append(all(rep[k] == o[k] for k in ("trades", "mean_r", "cagr", "mdd")))
    check = ("每组的\"PR #42 口径\"一行（同一份每天的计划，止损看盘中最低价、不设单票上限）和上一版报告的完整计划逐项一致"
             "（笔数、平均 R、年化、最大回撤），前后的差只来自这两处改动。" if all(same) else
             "**注意**：\"PR #42 口径\"一行和上一版报告的完整计划对不上，前后的差不全是这两处改动。")
    return out + ["", check]


def equity_pnl(t: dict) -> float:
    """这笔盈亏占进场前一天净值的比例。分母不随止损远近变，不会像 R 那样被几分钱的止损放大。"""
    return t["pnl"] * t["notional"] / (t["shares"] * t["fill"])


def day_range(bars: dict[str, ps.Bars], start: int) -> float:
    """每天最高最低价相差占收盘价的比例，所有票所有天的中位数：止损离进场多近算"在一天的正常波动里"。"""
    x = np.concatenate([((b.h - b.lo) / b.c)[start:] for b in bars.values()])
    return float(np.nanmedian(x))


TRADE_HEAD = ("| 票 | 信号日 | 打法 · 进场规则 | 单子 | 计划进场 / 成交 | 止损 | 第一目标 | 离场 | R |\n"
              "|---|---|---|---|---:|---:|---:|---|---:|")

LIMITS = [
    "**幸存者偏差**：B、C 组按 2026-11-20 的市值挑，是事后的赢家；A 组（ETF）没有这个问题，结论以 A 组和合并为准，D 组（曾经的巨头）量这个偏差。退市股取不到。",
    "**样本不独立**：同一天几十只票一起动。平均 R 的区间用 60 个交易日一块的日期区块自助法（按进场日分块），已算进这种相关，但区块之间仍不完全独立。",
    "**这不是没看过的数据**：这些品种都在 2026-11-20 的评估里（开发集或旧验证集），已经看过；不调任何参数（第 3 步做敏感度，第 4 步用新验证集）。",
    "**止损按收盘、第二天开盘走**：照计划原文。真实下单时有人会在收盘前几分钟看到要跌破就走，比这里早一点、亏得少一点；"
    "跳空低开的亏损全部算进去。P22（突破买入的起涨 K 线最低价）原文没写收盘，按\"收盘跌破小平台就是破线\"同样用收盘。",
    "**进场那一根不算目标**：保守，低估一部分赢的交易。",
    "**小时线**：回放没有小时线（Polygon 只回到 2021 年底），吃回撤的计划常写\"只差小时线多头排列（看小时图）\"。"
    "完整计划当作满足，\"要看小时线的不进\"当作不满足；真实使用时用户会看小时图，结果在两行之间。",
    "**目标只用第一个**：tradeplan 给了第二目标（20/60/120 全部汇聚处），但没说分几批走；这里到第一目标全部离场，不另造分批规则。",
    "**单子只在信号次日有效**：每天按当天的新计划重下；没有挂单多日的情形。",
    "**成本**：每边 0.05%，没算税、融资、做空；只做多。分红算进收益（含分红复权因子）。",
    "**复权价**：yfinance 复权价会被之后的分红、拆股回溯调整，对价位和均线方向的影响可以忽略。",
]


def render(groups: dict[str, dict], meta: dict, checks: list[dict]) -> str:
    pool = groups[POOLED]
    full = pool["runs"][FULL.name]
    cfg_pos = meta["config"]["max_position"]
    scope = "用户的核心名单" if meta["remaining"] else "2026-11-20 评估的开发集 + 旧验证集"
    out = [f"# 完整计划逐笔回测：{'核心名单' if meta['remaining'] else '开发集'}（{meta['first']} ~ {meta['last']}）", "",
           "回答\"照结论卡片的交易计划下单，结果怎样\"。只作风险提示，不改定位：归雁是把双均线交易系统用到真实交易上的工具。", "",
           f"- 生成：{meta['generated']}；代码 `{meta['head'][:12]}`；品种 {meta['n_tickers']} 只（{scope}，"
           f"A {meta['n_groups']['A']}、B {meta['n_groups']['B']}、C {meta['n_groups']['C']}、D {meta['n_groups']['D']}）",
           f"- 决定点 {meta['days']} 个（每只票每个交易日一份计划），其中 {meta['checked']} 个和完整分析（等于 `dma_analyze.py --csv --asof`）逐字段对过交易计划，全部一致",
           f"- 计划计算 {meta['seconds']['plans']:.0f}s（{meta['jobs']} 个进程），回测和报告 {meta['seconds']['sim']:.0f}s",
           "- 区间：平均 R 的 90% 区间，日期区块自助法（60 个交易日一块，重抽 2000 次）", ""]
    out += ["## 怎么下单", "",
            "- **进场**：信号日收盘后看结论卡片的空仓计划，有进场价、止损、第一目标，而且盈亏比 ≥ 3:1（\"可做\"或\"理想\"），就给第二天下单；单子只当天有效。",
            "  - 进场价高于收盘（要突破才买）：开盘就在进场价上方按开盘价成交（跳空），否则盘中最高价碰到进场价按进场价成交，否则不成交。",
            "  - 进场价等于收盘（\"按收盘进\"）：第二天开盘成交。",
            "  - 进场价低于收盘（回落到 60 线组才买）：开盘就在进场价下方按开盘价成交，否则盘中最低价碰到按进场价成交，否则不成交。",
            "  - 成交价不在止损上方（开盘就跌穿止损）：不进。",
            "  - 吃回撤 P11 的价位（\"回撤到 60 线组 X，之后还要底部构造、小时线多头排列\"）卡片写明不是进场价，不下单；"
            "\"回撤到 60 线组就买\"一行把它当限价单。",
            "  - P12（底部构造完成再加小时线）、P13（只差小时线）触发之后还要小时线多头排列。回放没有小时线，按卡片的价位下单，"
            "当作小时线满足；\"要看小时线的不进\"一行当作不满足。",
            "- **股数**：每笔可承受亏损 = 前一天收盘净值的 1%，股数 = 向下取整(可承受亏损 ÷ (计划进场价 − 止损))（A6）。"
            f"单票持仓金额不超过净值的 {cfg_pos * 100:.0f}%（视频没有这一条，回测自定，见 evaluation.toml；\"不设单票仓位上限\"一行去掉它）。"
            "所有持仓的初始风险加起来不超过净值的 6%（超了这笔不做）；现金不够就按现金能买的股数，不加杠杆。同一天几笔按票代码排序。",
            "- **离场**（先到先走）：止损按收盘，收盘低于止损价就第二天开盘走（计划写的都是\"收盘跌回 / 收盘低于 / 收盘跌破\"，P23 什么原则进就什么原则出）；"
            "目标（第一目标）是挂着的卖单，看盘中最高价，开盘已经越过就按开盘价；进场那一根不算目标。"
            "打法的失效条件收盘成立，第二天开盘走（横盘：P3、P5；稳定上涨：60 线组拐头向下；多头结构回撤中：EMA20 止损、J16 双死叉；加速下跌：EMA20 止损）。"
            "\"止损看盘中最低价\"一行是 PR #42 的口径：盘中碰到止损价就按止损价走，开盘已经跌穿按开盘价，同一根里止损和目标都碰到算先止损。",
            "- **R 倍数** = 这笔盈亏 ÷ 初始风险（股数 × (成交价 − 止损)），扣两边 0.05% 成本、含分红。收盘跌破之后第二天开盘才走，亏损常超过 1R，照实记，不截断。",
            "- **账户**：每组品种一个账户，起始 100 万，空仓的钱收益算 0。年化、回撤、MAR 都是这个账户的净值曲线。",
            "- **对照**：买入持有、MA200、MA60 朴素规则（每只票分一样多的钱，在场就满仓，不按仓位）；随机进场（同样的仓位规则、同样的止损和目标距离，"
            f"最多拿真实那笔的根数，{RANDOM_REPS} 次取中位数，括号里是 5% ~ 95%），它和完整计划的差就是\"进场选择值多少\"。", ""]
    if meta.get("before"):
        out += ["## 和上一版（PR #42）对照", "",
                "这一版只改了两处：止损按收盘判断、第二天开盘走（上一版看盘中最低价）；单票持仓金额不超过净值的 "
                f"{cfg_pos * 100:.0f}%（上一版不限）。每天的计划、进场规则、止损价位、目标、盈亏比过滤都没动。", "",
                *before_after(groups, meta["before"]), ""]
    out += ["## 结论", "", f"### {POOLED}（{len(pool['tickers'])} 只，{pool['start']} ~ {pool['end']}）", "", *group_table(pool), ""]
    rnd = pool["random"]
    ci = full["ci"]
    lines = [f"- 完整计划 {full['trades']} 笔，平均 {full['mean_r']:+.2f}R"
             + (f"，90% 区间 {ci[0]:+.2f} ~ {ci[1]:+.2f}R，{'跨 0' if ci[0] <= 0 <= ci[1] else '不跨 0'}" if ci else "") + "。"]
    if rnd and rnd["mean_r"] is not None:
        lines.append(f"- 随机进场（同仓位、同离场）平均 {rnd['mean_r']:+.2f}R，MAR {f2(rnd['mar'])}；完整计划 MAR {f2(full['mar'])}。")
    for n, _ in BASELINES:
        b = pool["baselines"][n]
        lines.append(f"- {n}：年化 {pc(b['cagr'])}、最大回撤 {pc(b['mdd'])}、MAR {f2(b['mar'])}。")
    out += lines + [""]
    if meta["remaining"]:
        ok, why = gate(pool)
        out += ["## 关口：要不要补测其余品种", "",
                "事先定的关口：完整计划在核心名单上，平均 R 的 90% 区间整个在 0 以上，而且 MAR 不低于同一批品种上的 MA200 朴素规则。", ""]
        if ok:
            out += ["**过关。** 其余品种待补测：" + " ".join(meta["remaining"]) + "。", ""]
        else:
            out += [f"**没过关**：{'；'.join(why)}。照卡片的完整计划在核心名单上没有显示出可验证的优势，"
                    "建议不再花时间补测其余 " + str(len(meta["remaining"])) + " 只（" + " ".join(meta["remaining"]) + "）。", ""]
    out += ["## 逐个关掉：盈亏比过滤、目标位、仓位各贡献多少", "",
            "每次只关一样，其余照完整计划。差 = 关掉之后 − 完整计划。\"关仓位\"每笔买同样的金额，"
            "金额取完整计划每笔进场金额占净值的平均（各组各算），所以平均用的钱差不多，只是不再按止损远近分配。", "",
            "| 组 | 关掉 | 笔数 | 平均 R 差 | 年化差 | 最大回撤差 | MAR 差 |", "|---|---|---:|---:|---:|---:|---:|"]
    for gname, g in groups.items():
        base = g["runs"][FULL.name]
        for v in ABLATIONS:
            s = g["runs"][v.name]
            d = {k: None if s[k] is None or base[k] is None else s[k] - base[k] for k in ("mean_r", "cagr", "mdd", "mar")}
            dr = "—" if d["mean_r"] is None else f"{d['mean_r']:+.2f}"
            dm = "—" if d["mar"] is None else f"{d['mar']:+.2f}"
            out.append(f"| {gname} | {v.name} | {s['trades']}（{s['trades'] - base['trades']:+d}） | {dr} | "
                       f"{pc(d['cagr'])} | {pc(d['mdd'])} | {dm} |")
    out += ["", "## 各组", ""]
    for gname, g in list(groups.items())[1:]:
        out += [f"### {gname}（{len(g['tickers'])} 只，{g['start']} ~ {g['end']}）", "", *group_table(g), ""]
    out += ["## 前后两段（完整计划，按进场日）", "", "| 组 | 2013–2019 | 2020–2026 |", "|---|---:|---:|"]
    for gname, g in groups.items():
        cells = []
        for h in ("2013–2019", "2020–2026"):
            x = g["halves"][h]
            if x["mean_r"] is None:
                cells.append("—")
                continue
            ci = "区间 —" if x["ci"] is None else f"{x['ci'][0]:+.2f} ~ {x['ci'][1]:+.2f}"
            cells.append(f"{x['mean_r']:+.2f}R（{ci}，{x['trades']} 笔）")
        out.append(f"| {gname} | {cells[0]} | {cells[1]} |")
    out += ["", f"## 完整计划的交易明细（{POOLED}）", ""]
    ts = pool["trades"]
    by_key = defaultdict(list)
    for t in ts:
        by_key[f"{t['key']} · {t['rule']}"].append(t["r"])
    out += ["按打法和进场规则：", "", "| 打法 · 进场规则 | 笔数 | 平均 R | 胜率 |", "|---|---:|---:|---:|"]
    for k, rs in sorted(by_key.items(), key=lambda x: -len(x[1])):
        out.append(f"| {k} | {len(rs)} | {np.mean(rs):+.2f} | {p0(float(np.mean(np.array(rs) > 0)))} |")
    unit = np.array([t["plan_entry"] - t["stop"] for t in ts])
    dist = unit / np.array([t["plan_entry"] for t in ts])
    in_atr = unit / np.array([t["atr"] for t in ts])
    out += ["", f"按止损离计划进场价多远（这段时间 {POOLED} 每天最高最低价相差的中位数是收盘价的 {meta['day_range'] * 100:.1f}%）：", "",
            BUCKET_HEAD, *bucket_rows(ts, dist, STOP_BUCKETS, lambda lo, hi: f"{lo * 100:g}% ~ {hi * 100:g}%" if hi < 1 else f"≥ {lo * 100:g}%"),
            "", f"按止损离计划进场价几个 ATR（信号日的 ATR({ATR_N})，Wilder 平均真实波幅；这批交易止损距离的中位数是 "
            f"{np.median(in_atr):.2f} 个 ATR）：", "",
            BUCKET_HEAD, *bucket_rows(ts, in_atr, ATR_BUCKETS, lambda lo, hi: f"{lo:g} ~ {hi:g} ATR" if hi < float("inf") else f"≥ {lo:g} ATR")]
    rs_all = np.array([t["r"] for t in ts])
    eq_all = np.array([equity_pnl(t) for t in ts])
    calm = np.argsort(-np.abs(rs_all))[10:]
    out += ["", f"R 的分母是这笔的初始风险。止损离成交价只有几分钱时分母极小，按收盘止损、第二天开盘走，单笔 R 可以到正负几十（见下面 R 最高、最低的 10 笔），"
            f"平均 R 由少数几笔决定：全部 {len(ts)} 笔平均 {rs_all.mean():+.2f}R，去掉 |R| 最大的 10 笔是 {rs_all[calm].mean():+.2f}R，"
            f"中位 {np.median(rs_all):+.2f}R。每笔盈亏占前一天净值不受分母影响：平均 {pc(float(eq_all.mean()), 2)}、"
            f"中位 {pc(float(np.median(eq_all)), 2)}。"]
    kinds = Counter(t["kind"] for t in ts)
    out += ["", "单子类型：" + "，".join(f"{k} {v} 笔" for k, v in kinds.most_common()) + "。",
            "离场原因：" + "，".join(f"{k} {v} 笔" for k, v in Counter(t["reason"] for t in ts).most_common()) + "。",
            "没成交的单：" + ("，".join(f"{k} {v} 张" for k, v in sorted(full["skipped"].items(), key=lambda x: -x[1])) or "无") + "。", ""]
    top = sorted(ts, key=lambda t: -t["r"])[:10]
    bottom = sorted(ts, key=lambda t: t["r"])[:10]
    out += ["R 最高的 10 笔：", "", TRADE_HEAD, *map(trade_line, top), "", "R 最低的 10 笔：", "", TRADE_HEAD, *map(trade_line, bottom), ""]
    out += ["## 和结论卡片对一遍", "",
            "抽 5 笔，用 `dma_analyze.py --csv <信号日往前 5 年> --asof <信号日> --json` 重算那天的计划（结论卡片读的就是它），"
            "进场价、止损、第一目标、盈亏比结论都要和回测下的单一样；再对着第二天的开高低看成交价。", "",
            "| 票 | 信号日 | 卡片：进场 / 止损 / 第一目标 / 结论 | 回测的单 | 次日 开 / 高 / 低 | 成交 | 一致 |", "|---|---|---|---|---|---:|---|"]
    for c in checks:
        t, k, nb = c["trade"], c["card"], c["next_bar"]
        out.append(f"| {t['ticker']} | {t['signal_date']} | {k['entry']:.2f} / {k['stop']:.2f} / {k['t1']:.2f} / {k['verdict']}（{k['condition']}） | "
                   f"{t['kind']} {t['plan_entry']:.2f} / {t['stop']:.2f} / {t['target']:.2f} | "
                   f"{nb['Open']:.2f} / {nb['High']:.2f} / {nb['Low']:.2f} | {t['fill']:.2f} | {'是' if c['same'] else '**否**'} |")
    out += ["", "## 不能当真的地方", "", *[f"- {x}" for x in LIMITS], ""]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tickers", help="只跑这些（逗号分隔），默认评估的全部品种")
    p.add_argument("--core", action="store_true", help="只跑用户的核心名单（CORE），报告里写关口和待补测的品种")
    p.add_argument("--config", type=Path, default=ev.CONFIG)
    p.add_argument("--out", type=Path, default=PROJECT / "reports/replay")
    p.add_argument("--data", type=Path, help="行情缓存，默认 <out>/data/eval")
    p.add_argument("--jobs", type=int, default=14)
    p.add_argument("--stem", default="2026-11-21-fullplan-dev")
    p.add_argument("--before", type=Path, help="上一版报告的 JSON，报告里加一节前后对照")
    a = p.parse_args()
    cfg = es.load_config(a.config)
    data = a.data or a.out / "data" / "eval"
    u = json.loads((a.out / "eval" / f"universe-{cfg['sample']['snapshot']}.json").read_text())
    gof = {t: g for g, ts in u["groups"].items() for t in ts}
    tickers = sorted(CORE if a.core else (t.strip().upper() for t in a.tickers.split(",")) if a.tickers else gof)
    t0 = time.time()
    recs = daily(tickers, data, a.out, cfg, a.jobs)
    t_plans = time.time() - t0
    cal, bars, sigs = load_bars(tickers, data)
    cost = cfg["sample"]["cost"]
    jobs = []
    for name, gs in GROUPS:
        ts = [t for t in tickers if gof.get(t) in gs]
        if ts:
            jobs.append((name, ts, {t: recs[t] for t in ts}, cal, {t: bars[t] for t in ts}, {t: sigs[t] for t in ts},
                         cfg["bootstrap"], cost, cfg["fullplan"]["max_position"]))
    with ProcessPoolExecutor(max_workers=min(a.jobs, len(jobs))) as ex:
        groups = dict(ex.map(run_group, jobs))
    groups = {name: groups[name] for name, _ in GROUPS if name in groups}
    lead = groups.get(POOLED) or next(iter(groups.values()))
    checks = card_check(lead["trades"], sigs)
    days = [r["d"] for rs in recs.values() for r in rs]
    meta = {"generated": datetime.now().isoformat(timespec="seconds"), "head": ev.git("rev-parse", "HEAD"),
            "n_tickers": len(tickers), "n_groups": {g: sum(gof.get(t) == g for t in tickers) for g in "ABCD"},
            "first": min(days), "last": max(days), "days": len(days),
            "checked": sum(1 for rs in recs.values() for k in range(0, len(rs), CHECK_EVERY)), "jobs": a.jobs,
            "seconds": {"plans": round(t_plans, 1), "sim": round(time.time() - t0 - t_plans, 1)},
            "config": asdict(ps.Config(cost=cost, max_position=cfg["fullplan"]["max_position"])), "random_reps": RANDOM_REPS,
            "day_range": day_range({t: bars[t] for t in lead["tickers"]}, cal.index(lead["start"])),
            "remaining": sorted(set(gof) - set(tickers)) if a.core else []}
    before = json.loads(a.before.read_text()) if a.before else None
    md = render(groups, {**meta, "before": before}, checks)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"{a.stem}.md").write_text(md)
    (a.out / f"{a.stem}.json").write_text(json.dumps({"meta": meta, "groups": groups, "card_check": checks},
                                                     ensure_ascii=False, indent=1, default=str) + "\n")
    print(md)
    print(f"报告：{a.out / a.stem}.md（计划 {t_plans:.0f}s，共 {time.time() - t0:.0f}s）", file=sys.stderr)
    if not all(c["same"] for c in checks):
        sys.exit("有交易和结论卡片对不上，见报告")


if __name__ == "__main__":
    main()
