#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
#     "yfinance",
# ]
# ///
"""回测方案 → 一次完整计划回测 → 结果 JSON。工作台的「回测」页存方案、调它、读它的结果。

用法：
  uv run planrun.py --template > my.toml          # 默认方案（带说明），改完再跑
  uv run planrun.py my.toml --estimate            # 规模和预计时间（JSON）
  uv run planrun.py my.toml --out result.json     # 跑；stdout 每行一个 JSON 进度事件，结果写到 --out

- 方案文件的格式见 --template 的注释。缺键、多键、类型不对、取值不在范围里都直接报错，不猜。
- 每天的计划和 fullplan.py 共用缓存（<cache>/fullplan/daily/<票>.jsonl）：只改执行参数（止损口径、仓位、目标……）几秒重跑；
  没缓存的票要从头算每天的计划，一只票约十几秒到一分钟。没有行情的票先用 yfinance 下载到 --data。
- 成交、仓位、指标的规则在 plansim.py，计划变成单在 fullplan.py；这里只把方案变成它们的参数。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import tomllib
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import evalstats as es  # noqa: E402
import evaluate as ev  # noqa: E402
import fullplan as fp  # noqa: E402
import holdout as ho  # noqa: E402
import plansim as ps  # noqa: E402

PROJECT = SCRIPTS.parents[3]
OUT = PROJECT / "reports/replay"
RESULT_KIND = "dma-backtest-result"
VERSION = 1
MAX_TICKERS = 100
TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.\-^=]{0,14}$")
NAME = re.compile(r"^[\w][\w \-·]{0,39}$")
FLOORS = (0.0, 0.5, 1.0)
BASELINES = (("买入持有", None), ("MA200 朴素规则", 200))
# 一个决定点的计划约 0.06s，每 20 个再和完整分析对一次：平均按 0.075s 估
SECONDS_PER_DAY = 0.075
SECONDS_PER_DOWNLOAD = 3.0


class PlanError(ValueError):
    """方案文件不对：说清哪个键、为什么。"""


@dataclass(frozen=True)
class Execution:
    stop: str                       # close：收盘跌破止损第二天开盘走；intraday：盘中碰到就走（对照）
    risk: str                       # pct：每笔可承受亏损按净值的比例；amount：固定金额
    risk_pct: float
    risk_amount: float
    account: float
    max_position: float | None      # 单票持仓金额上限占净值的比例，None 不限
    rr_filter: bool                 # 盈亏比不到 3:1 的不做
    targets: bool                   # 挂第一目标（P25：到了中长线完好就继续拿，不完好就走）；False 拿到止损或失效
    stop_floor_atr: float           # 止损下限，几个 ATR(14)；0 不用
    cost: float                     # 每边手续费比例


@dataclass(frozen=True)
class Plan:
    name: str
    mode: str
    universe: str                   # tickers / watchlist / core
    tickers: tuple[str, ...]
    start: str
    end: str
    execution: Execution

    def sim_config(self) -> ps.Config:
        x = self.execution
        return ps.Config(risk_pct=x.risk_pct, risk_amount=x.risk_amount if x.risk == "amount" else None,
                         stop_on_close=x.stop == "close", max_position=x.max_position, cost=x.cost, equity0=x.account,
                         stop_floor_atr=x.stop_floor_atr or None)

    def variant(self) -> fp.Variant:
        return fp.Variant(self.name, rr_filter=self.execution.rr_filter, targets=self.execution.targets)


# ---------- 方案文件 ----------

def template(cfg: dict) -> str:
    """默认方案：等于 2026-11-21 完整计划报告的口径（核心名单那份），带每个键的说明。"""
    return f'''# 回测方案。工作台「回测」页存成 data/backtests/<name>.toml；命令行：uv run planrun.py <文件> --out result.json
version = 1
name = "完整计划"
mode = "fullplan"          # 测什么。第一期只有 fullplan（照结论卡片的完整计划下单）

[universe]
kind = "tickers"           # tickers：下面列的代码；core：核心名单（fullplan.CORE）；watchlist：自选股（工作台运行前把当时的自选股填进 tickers）
tickers = ["NVDA"]

[period]
start = "{cfg['sample']['first_decision']}"     # 第一个决定点；每个决定点要往前 3 年的行情，再早没有计划
end = "{(pd.Timestamp(cfg['sample']['snapshot']) - pd.Timedelta(days=1)).date()}"       # 行情取到这天为止（evaluation.toml 的 snapshot 前一天）

[execution]
stop = "close"             # close：收盘跌破止损、第二天开盘走（计划原文）；intraday：盘中碰到就走（对照）
risk = "pct"               # pct：每笔可承受亏损 = 前一天净值 × risk_pct%；amount：固定 risk_amount
risk_pct = 1.0
risk_amount = 10000.0      # risk = "amount" 时用
account = 1000000.0        # 起始资金
max_position = {cfg['fullplan']['max_position']}       # 单票持仓金额上限，占净值的比例；0 = 不限（脚本自定）
rr_filter = true           # 盈亏比不到 3:1 的不做
targets = true             # 第一目标是检查点（P25）：到了中长线完好就继续拿，不完好就走；false = 不看目标，拿到止损或失效
stop_floor_atr = 0.0       # 止损离进场不到 k 个 ATR(14) 就放宽到 k 个 ATR；0 / 0.5 / 1（脚本自定，0 = 不用）
cost = {cfg['sample']['cost']}              # 每边手续费比例
'''


def _table(doc: dict, key: str, keys: dict[str, type | tuple[type, ...]], where: str = "") -> dict:
    t = doc.get(key) if key else doc
    label = f"[{key}]" if key else "顶层"
    if not isinstance(t, dict):
        raise PlanError(f"缺 {label}")
    extra = set(t) - set(keys)
    if extra:
        raise PlanError(f"{label} 有不认识的键 {sorted(extra)}")
    for k, want in keys.items():
        if k not in t:
            raise PlanError(f"{label} 缺 {k}")
        v = t[k]
        if isinstance(v, bool) != (want is bool) or not isinstance(v, want):   # true 不能当数字用
            raise PlanError(f"{label} {k} 的类型不对：{v!r}{where}")
    return t


def _day(v: str, key: str) -> str:
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise PlanError(f"[period] {key} 应为 YYYY-MM-DD：{v!r}") from None


def _in(v: float, lo: float, hi: float, key: str, lo_open: bool = True) -> float:
    if not (lo < v <= hi if lo_open else lo <= v <= hi):
        raise PlanError(f"[execution] {key} = {v} 不在 {'(' if lo_open else '['}{lo}, {hi}] 里")
    return float(v)


def parse_plan(text: str) -> Plan:
    try:
        doc = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise PlanError(f"TOML 语法错误：{e}") from None
    num = (int, float)
    top = _table(doc, "", {"version": int, "name": str, "mode": str, "universe": dict, "period": dict, "execution": dict})
    if top["version"] != VERSION:
        raise PlanError(f"version 应为 {VERSION}：{top['version']}")
    if not NAME.match(top["name"]):
        raise PlanError(f"name 只能用文字、数字、空格、- 和 ·，最多 40 个字：{top['name']!r}")
    if top["mode"] != "fullplan":
        raise PlanError(f"mode 只能是 fullplan（其余是第二期）：{top['mode']!r}")
    kind = doc["universe"].get("kind")
    if kind not in ("tickers", "watchlist", "core"):
        raise PlanError(f"[universe] kind 只能是 tickers / watchlist / core：{kind!r}")
    raw = _table(doc, "universe", {"kind": str, "tickers": list})["tickers"]
    if not all(isinstance(t, str) for t in raw):
        raise PlanError("[universe] tickers 应为代码的数组")
    tickers = list(dict.fromkeys(t.strip().upper() for t in raw))
    bad = [t for t in tickers if not TICKER.match(t)]
    if bad:
        raise PlanError(f"[universe] tickers 里的代码不合法：{bad}")
    if kind == "tickers" and not tickers:
        raise PlanError("[universe] kind = tickers 要至少列一只票")
    if len(tickers) > MAX_TICKERS:
        raise PlanError(f"[universe] 最多 {MAX_TICKERS} 只票，现在 {len(tickers)} 只")
    p = _table(doc, "period", {"start": str, "end": str}, "（日期要加引号）")
    start, end = _day(p["start"], "start"), _day(p["end"], "end")
    if start >= end:
        raise PlanError(f"[period] start {start} 要早于 end {end}")
    x = _table(doc, "execution", {"stop": str, "risk": str, "risk_pct": num, "risk_amount": num, "account": num,
                                  "max_position": num, "rr_filter": bool, "targets": bool, "stop_floor_atr": num, "cost": num})
    if x["stop"] not in ("close", "intraday"):
        raise PlanError(f"[execution] stop 只能是 close / intraday：{x['stop']!r}")
    if x["risk"] not in ("pct", "amount"):
        raise PlanError(f"[execution] risk 只能是 pct / amount：{x['risk']!r}")
    if float(x["stop_floor_atr"]) not in FLOORS:
        raise PlanError(f"[execution] stop_floor_atr 只能是 0 / 0.5 / 1：{x['stop_floor_atr']}")
    mp = _in(x["max_position"], 0, 1, "max_position", lo_open=False)
    ex = Execution(stop=x["stop"], risk=x["risk"], risk_pct=_in(x["risk_pct"], 0, 10, "risk_pct"),
                   risk_amount=_in(x["risk_amount"], 0, 1e12, "risk_amount"), account=_in(x["account"], 0, 1e12, "account"),
                   max_position=mp or None, rr_filter=x["rr_filter"], targets=x["targets"],
                   stop_floor_atr=float(x["stop_floor_atr"]), cost=_in(x["cost"], 0, 0.01, "cost", lo_open=False))
    if ex.risk == "amount" and ex.risk_amount > ex.account:
        raise PlanError(f"[execution] risk_amount {ex.risk_amount:g} 比起始资金 {ex.account:g} 还大")
    return Plan(top["name"], top["mode"], kind, tuple(tickers), start, end, ex)


def plan_doc(plan: Plan) -> dict:
    """方案写回文件的形状（结果 JSON 里原样带上，工作台用同一个 schema 读）。"""
    x = asdict(plan.execution)
    x["max_position"] = x["max_position"] or 0.0
    return {"version": VERSION, "name": plan.name, "mode": plan.mode,
            "universe": {"kind": plan.universe, "tickers": list(plan.tickers)},
            "period": {"start": plan.start, "end": plan.end}, "execution": x}


def resolve(plan: Plan) -> list[str]:
    if plan.universe == "core":
        return list(fp.CORE)
    if not plan.tickers:
        raise PlanError("自选股是空的：工作台运行前会把当时的自选股填进 [universe] tickers")
    return list(plan.tickers)


def nondefault(plan: Plan, cfg: dict) -> list[dict]:
    """和完整计划报告的口径不一样的执行参数。origin：脚本自定（视频没有，回测自己定的）或完整计划（卡片本身的规则）。"""
    x = plan.execution
    rows = (("stop", "止损", x.stop, "close", "脚本自定"),
            ("max_position", "单票仓位上限", x.max_position, cfg["fullplan"]["max_position"], "脚本自定"),
            ("stop_floor_atr", "止损下限（ATR）", x.stop_floor_atr, 0.0, "脚本自定"),
            ("cost", "手续费", x.cost, cfg["sample"]["cost"], "脚本自定"),
            ("rr_filter", "盈亏比过滤", x.rr_filter, True, "完整计划"),
            ("targets", "第一目标（P25 检查点）", x.targets, True, "完整计划"))
    return [{"key": k, "label": label, "value": v, "default": d, "origin": o} for k, label, v, d, o in rows if v != d]


def holdout(tickers: list[str]) -> dict:
    """第 4 步的新验证集（references/holdout.json）：碰到的票照跑，但标出来，并告诉用户这批票已经被跑过几次。"""
    doc = ho.load_list(ho.LIST_FILE)
    overlap = sorted(set(tickers) & set(ho.tickers_of(doc))) if doc else []
    return {"locked": doc is not None, "overlap": overlap, "runs": len(ho.runs(ho.RUNS_FILE))}


def touch_holdout(hold: dict) -> dict:
    """真跑一次碰到验证集的方案：记一笔（references/holdout-runs.json），runs 换成记完之后的次数。"""
    if not hold["overlap"]:
        return hold
    return {**hold, "runs": ho.record_run("planrun.py", hold["overlap"], ev.git("rev-parse", "HEAD"), ho.RUNS_FILE)}


# ---------- 估计规模 ----------

def estimate(plan: Plan, data: Path, out: Path, jobs: int) -> dict:
    """跑之前的规模：每只票这段时间几个决定点、有没有缓存、要不要下载，和大概要多久。"""
    cfg = es.load_config(ev.CONFIG)
    tickers = resolve(plan)
    rows, compute_days = [], 0
    for t in tickers:
        csv = data / f"{t}.csv"
        if not csv.exists():
            rows.append({"ticker": t, "status": "download", "days": None})
            compute_days += 252 * 14
            continue
        px, _ = ev.load_prices(csv)
        try:
            first = ev.first_index(px, cfg)
        except ValueError:
            rows.append({"ticker": t, "status": "short", "days": 0})
            continue
        idx = px.index[first:]
        days = int(((idx >= pd.Timestamp(plan.start)) & (idx <= pd.Timestamp(plan.end))).sum())
        cached = fp.is_cached(fp.cache_file(out, t), fp.fingerprint(csv, cfg))
        if not cached:
            compute_days += len(px) - first
        rows.append({"ticker": t, "status": "cached" if cached else "compute", "days": days})
    n = {s: sum(r["status"] == s for r in rows) for s in ("cached", "compute", "download", "short")}
    seconds = compute_days * SECONDS_PER_DAY / max(jobs, 1) + n["download"] * SECONDS_PER_DOWNLOAD + 2 + 0.3 * len(tickers)
    return {"tickers": tickers, "rows": rows, "counts": n, "days": sum(r["days"] or 0 for r in rows),
            "compute_days": compute_days, "jobs": jobs, "seconds": round(seconds), "holdout": holdout(tickers)}


# ---------- 跑 ----------

def emit(event: str, **kw) -> None:
    print(json.dumps({"event": event, **kw}, ensure_ascii=False), flush=True)


def simulate_plan(plan: Plan, recs: dict[str, list[dict]], cal: list[str], bars: dict[str, ps.Bars],
                  sigs: dict[str, pd.DataFrame], cfg: dict) -> dict:
    """recs 已经截到方案的时间段、cal 截到 end。返回结果 JSON 的 summary / equity / trades 三块。"""
    pos = {d: k for k, d in enumerate(cal)}
    start = min(pos[rs[0]["d"]] for rs in recs.values())
    atrs = None
    if plan.execution.stop_floor_atr:
        idx = pd.DatetimeIndex(pd.to_datetime(cal))
        atrs = {t: fp.atr(sigs[t]).reindex(idx).to_numpy(dtype=float) for t in recs}
    res = ps.simulate(len(cal), bars, fp.orders_for(recs, pos, bars, plan.variant(), atrs), fp.inval_for(recs, pos, len(cal)),
                      start, plan.sim_config(), fp.hold_for(recs, pos, len(cal)))
    s = fp.summarize(res, cal, cfg["bootstrap"])
    trades = [{**asdict(t), "signal_date": cal[t.signal], "entry_date": cal[t.entry_i], "exit_date": cal[t.exit_i]} for t in res.trades]
    for t in trades:
        t["equity_pct"] = fp.equity_pnl(t)
    eqp = np.array([t["equity_pct"] for t in trades])
    s.update(equity_pct_mean=float(eqp.mean()) if len(eqp) else None, equity_pct_median=float(np.median(eqp)) if len(eqp) else None)
    firsts = {t: rs[0]["d"] for t, rs in recs.items()}
    names = sorted(recs)
    curves, base = {}, {}
    for name, rule in BASELINES:
        eq, exposure = fp.basket(names, sigs, bars, firsts, cal, start, plan.execution.cost, rule)
        curves[name], base[name] = eq, fp.curve_stats(eq, exposure)
    r5 = lambda a: [round(float(v), 5) for v in a]  # noqa: E731
    return {"summary": {"plan": s, "baselines": base},
            "equity": {"dates": cal[start:], "plan": r5(res.equity / res.equity[0]), **{n: r5(c) for n, c in curves.items()}},
            "trades": [{k: t[k] for k in TRADE_KEYS} for t in sorted(trades, key=lambda t: (t["entry_date"], t["ticker"]))]}


TRADE_KEYS = ("ticker", "key", "rule", "kind", "signal_date", "entry_date", "exit_date", "plan_entry", "fill", "stop", "target",
              "rr", "exit_px", "shares", "reason", "r", "pnl", "notional", "equity_pct")


def run(plan: Plan, data: Path, out: Path, jobs: int) -> dict:
    cfg = es.load_config(ev.CONFIG)
    tickers = resolve(plan)
    hold = holdout(tickers)
    t0 = time.time()
    skipped: dict[str, str] = {}
    ready = []
    for k, t in enumerate(tickers, 1):
        csv = data / f"{t}.csv"
        if not csv.exists():
            emit("progress", stage="data", done=k - 1, total=len(tickers), text=f"下载 {t} 的行情")
            if ev.fetch(t, data, cfg) is None:
                skipped[t] = "取不到行情"
                continue
        try:
            ev.first_index(ev.load_prices(csv)[0], cfg)
        except ValueError:
            skipped[t] = "历史不足 3 年，没有计划"
            continue
        ready.append(t)
    if not ready:
        raise PlanError("没有能回测的票：" + "；".join(f"{t} {why}" for t, why in skipped.items()))
    t1 = time.time()
    computed = [t for t in ready if not fp.is_cached(fp.cache_file(out, t), fp.fingerprint(data / f"{t}.csv", cfg))]
    emit("progress", stage="plans", done=0, total=1, text=f"每天的计划：{len(ready) - len(computed)} 只有缓存，{len(computed)} 只要算")
    recs = fp.daily(ready, data, out, cfg, jobs, lambda n, total, note: emit("progress", stage="plans", done=n, total=total, text=note))
    t2 = time.time()
    emit("progress", stage="sim", done=0, total=1, text="逐笔模拟")
    cal, bars, sigs = fp.load_bars(ready, data)
    n = int(np.searchsorted(np.asarray(cal), plan.end, side="right"))
    cal = cal[:n]
    bars = {t: ps.Bars(*(a[:n] for a in (b.o, b.h, b.lo, b.c, b.f))) for t, b in bars.items()}
    sigs = {t: s[s.index <= pd.Timestamp(plan.end)] for t, s in sigs.items()}
    period = {t: [r for r in rs if plan.start <= r["d"] <= plan.end] for t, rs in recs.items()}
    for t in [t for t, rs in period.items() if not rs]:
        skipped[t] = "这段时间没有计划"
        del period[t]
    if not period:
        raise PlanError(f"{plan.start} ~ {plan.end} 没有可用的计划（每个决定点要往前 3 年的行情）")
    body = simulate_plan(plan, period, cal, bars, sigs, cfg)
    hold = touch_holdout(hold)              # 结果算出来了，算看过一次验证集
    days = [r["d"] for rs in period.values() for r in rs]
    meta = {"generated": datetime.now().isoformat(timespec="seconds"), "head": ev.git("rev-parse", "HEAD"),
            "tickers": sorted(period), "skipped": skipped, "start": min(days), "end": max(days), "days": len(days),
            "computed": computed, "seconds": {"data": round(t1 - t0, 1), "plans": round(t2 - t1, 1), "sim": round(time.time() - t2, 1)}}
    return {"kind": RESULT_KIND, "version": VERSION, "plan": plan_doc(plan), "meta": meta,
            "nondefault": nondefault(plan, cfg), "holdout": hold, **body}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("plan", nargs="?", type=Path, help="方案文件（TOML）")
    p.add_argument("--template", action="store_true", help="打印默认方案")
    p.add_argument("--estimate", action="store_true", help="只估计规模和时间，打印 JSON")
    p.add_argument("--out", type=Path, help="结果 JSON 写到这里")
    p.add_argument("--cache", type=Path, default=OUT, help="每天计划的缓存在 <cache>/fullplan/daily，默认 reports/replay")
    p.add_argument("--data", type=Path, help="行情，默认 <cache>/data/eval")
    p.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = p.parse_args()
    if a.template:
        print(template(es.load_config(ev.CONFIG)), end="")
        return
    if not a.plan or not (a.estimate or a.out):
        p.error("要给方案文件，和 --estimate 或 --out")
    data = a.data or a.cache / "data" / "eval"
    try:
        plan = parse_plan(a.plan.read_text(encoding="utf-8"))
        if a.estimate:
            print(json.dumps(estimate(plan, data, a.cache, a.jobs), ensure_ascii=False))
            return
        result = run(plan, data, a.cache, a.jobs)
    except PlanError as e:
        sys.exit(f"{a.plan}：{e}")
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, default=str) + "\n")
    tmp.replace(a.out)
    emit("done", trades=len(result["trades"]), seconds=round(sum(result["meta"]["seconds"].values()), 1))


if __name__ == "__main__":
    main()
