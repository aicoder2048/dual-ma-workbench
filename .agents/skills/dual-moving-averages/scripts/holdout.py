#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
#     "yfinance",
# ]
# ///
"""新验证集：只跑一次的完整计划最终检验（FULL_PLAN_EVAL 第 4 步）。

用法：
  uv run holdout.py build --out <reports/replay>     # 冻结代码和口径，按规则生成名单，写 references/holdout.json（看结果之前）
  uv run holdout.py run --out <reports/replay>       # 跑一次：完整计划 + 对照，按事先定的三条判定，写报告；计数加一
  uv run holdout.py render --out <reports/replay>    # 按存下的 JSON 重写报告（不重跑、不计数）

- 名单写进 references/holdout.json（进仓库），判定标准也写在里面，跑之前就提交。
- 每跑一次（holdout.py run，或工作台回测碰到这些票）在 references/holdout-runs.json 记一笔。第二次起 run 要加 --rerun，报告醒目标出。
- 口径完全照 2026-11-21-fullplan-core-p25 报告的完整计划：按收盘止损、单票 25% 上限、每笔 1% 风险、盈亏比过滤、新 P25、不设止损下限。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import evalstats as es  # noqa: E402
import evaluate as ev  # noqa: E402
import fullplan as fp  # noqa: E402
import plansim as ps  # noqa: E402

SKILL = SCRIPTS.parent
LIST_FILE = SKILL / "references" / "holdout.json"
RUNS_FILE = SKILL / "references" / "holdout-runs.json"
STEM = "2026-11-21-holdout"

ETFS = ("VTI IWF IWD MDY VGK EWJ FXI EWZ INDA IBB XBI KRE XHB ITB XOP GDX SLV USO IEF HYG").split()
CAP_LO, CAP_HI = 8.0e10, 2.0e11
N_STOCKS = 30
# 之前用过的品种：2026-11-20 评估的 95 只（含历史不足被排除的）另从 universe JSON 读；PR #20 逐笔回测的 14 只；核心名单 38 只
PR20 = ("NVDA TSLA AAPL GOOG META MSFT AMZN SPY QQQ INTC PYPL NKE BA DIS").split()
# 不进冻结哈希的脚本：工作台适配（planrun）、HTML 报告、K 线着色、本文件
NOT_FROZEN = ("planrun.py", "html_report.py", "tones.py", "holdout.py")

RULE = [
    f"ETF：计划里写死的 {len(ETFS)} 只（{' '.join(ETFS)}）。",
    "个股候选池：yfinance 筛选器，`intradaymarketcap` 在 800 亿 ~ 2000 亿美元之间、region = us，按市值从大到小全部翻页取回（快照日 2026-11-20）。",
    "候选只留：quoteType = EQUITY、挂在美国交易所（evaluation.toml 的 exchanges：NYSE、Nasdaq 三层、NYSE American），场外（PNK、OQX）不算美国上市；"
    "报价里的 marketCap 在 800 亿 ~ 2000 亿美元之间。",
    "三个月日均成交额不到 5000 万美元的去掉（evaluation.toml 的 min_dollar_volume，挡市值数据出错和优先股）。",
    "同一家公司的几类股（代码根相同或名字相同，如 PBR / PBR-A）只留市值大的一类。",
    "之前任何一次评估或回测用过的去掉：2026-11-20 评估的 95 只（含被排除的）、PR #20 逐笔回测的 14 只、核心名单 38 只。",
    "按市值从大到小，取前 30 只；历史不足的（到快照日不满 3.25 年，evaluation.toml 的 min_history_years）去掉，往后补。",
    "历史窗口按标准 3 年口径：每只票第一个决定点是 2013-01-02 和它上市满 3 年那天里较晚的一天，不要求 2013 年前就有 3 年历史。",
]
CRITERIA = [
    ("a", "平均 R 的 90% 区间（60 个交易日一块的日期区块自助法）整个在 0 以上：合并组完整计划。"),
    ("b", "合并组完整计划账户的 MAR 不低于同一批品种上 MA200 朴素规则的 MAR。"),
    ("c", "ETF 组和个股组方向一致：两组完整计划的平均 R 点估计同号（都 > 0 或都 < 0）。"),
]


# ---------- 冻结 ----------

def frozen_files() -> list[Path]:
    return [p for p in sorted(SCRIPTS.glob("*.py")) if p.name not in NOT_FROZEN] + [ev.CONFIG]


def settings(cfg: dict) -> dict:
    """完整计划的执行口径（等于 fullplan.FULL + core p25 报告的 ps.Config）。"""
    return {"variant": asdict(fp.FULL),
            "config": asdict(ps.Config(cost=cfg["sample"]["cost"], max_position=cfg["fullplan"]["max_position"])),
            "first_decision": cfg["sample"]["first_decision"], "snapshot": cfg["sample"]["snapshot"],
            "bootstrap": cfg["bootstrap"], "random": {"reps": fp.RANDOM_REPS, "seed": fp.RANDOM_SEED}}


def config_hash(cfg: dict) -> str:
    h = hashlib.sha256()
    for p in frozen_files():
        h.update(p.name.encode() + b"\0" + p.read_bytes())
    h.update(json.dumps(settings(cfg), sort_keys=True, ensure_ascii=False).encode())
    return h.hexdigest()


# ---------- 名单 ----------

def earlier_sets(universe: dict) -> dict[str, set[str]]:
    used = {t for ts in universe["groups"].values() for t in ts} | {e["ticker"] for e in universe["excluded"]}
    return {"2026-11-20 评估": used, "PR #20 逐笔回测": set(PR20), "核心名单": set(fp.CORE)}


def pick(quotes: list[dict], earlier: dict[str, set[str]], history_start: Callable[[str], pd.Timestamp | None],
         min_start: pd.Timestamp, exchanges: list[str], min_dollar: float, n: int = N_STOCKS) -> tuple[list[dict], list[dict]]:
    """按规则从候选池挑个股：(选中的, 去掉的 + 原因)。只在排到前 n 的候选上取行情查历史。"""
    excluded, rows, seen = [], [], {}
    for x in quotes:
        sym, cap = x["symbol"], x.get("marketCap")
        if x.get("quoteType") != "EQUITY" or x.get("exchange") not in exchanges or not cap or not CAP_LO <= cap <= CAP_HI:
            continue
        dollar = (x.get("regularMarketPrice") or 0) * (x.get("averageDailyVolume3Month") or 0)
        if dollar < min_dollar:
            excluded.append({"ticker": sym, "cap": cap, "reason": f"日均成交额 {dollar / 1e6:.1f} 百万美元，不到 {min_dollar / 1e6:.0f} 百万"})
            continue
        rows.append({"ticker": sym, "name": x.get("shortName") or sym, "cap": cap})
    rows.sort(key=lambda r: (-r["cap"], r["ticker"]))
    kept = []
    for r in rows:
        key = r["ticker"].split("-")[0]
        other = seen.get(key) or seen.get(r["name"])
        if other:
            excluded.append({"ticker": r["ticker"], "cap": r["cap"], "reason": f"和 {other} 是同一家公司，留市值大的"})
            continue
        seen[key] = seen[r["name"]] = r["ticker"]
        used = [name for name, s in earlier.items() if r["ticker"] in s]
        if used:
            excluded.append({"ticker": r["ticker"], "cap": r["cap"], "reason": "之前用过：" + "、".join(used)})
            continue
        kept.append(r)
    chosen = []
    for r in kept:
        if len(chosen) == n:
            break
        start = history_start(r["ticker"])
        if start is None:
            excluded.append({"ticker": r["ticker"], "cap": r["cap"], "reason": "取不到行情"})
        elif start > min_start:
            excluded.append({"ticker": r["ticker"], "cap": r["cap"], "reason": f"历史不足（{start.date()} 起）"})
        else:
            chosen.append({**r, "first_bar": str(start.date())})
    return chosen, excluded


def screen_pool() -> list[dict]:
    import yfinance as yf
    from yfinance import EquityQuery

    q = EquityQuery("and", [EquityQuery("btwn", ["intradaymarketcap", CAP_LO, CAP_HI]), EquityQuery("eq", ["region", "us"])])
    quotes, offset = [], 0
    while True:
        r = yf.screen(q, offset=offset, size=250, sortField="intradaymarketcap", sortAsc=False)
        quotes += r["quotes"]
        offset += len(r["quotes"])
        if not r["quotes"] or offset >= r.get("total", 0):
            return quotes


def build(out: Path, data: Path) -> dict:
    cfg = es.load_config(ev.CONFIG)
    if LIST_FILE.exists():
        sys.exit(f"{LIST_FILE} 已经有了：名单只生成一次")
    universe = json.loads((out / "eval" / f"universe-{cfg['sample']['snapshot']}.json").read_text())
    earlier = earlier_sets(universe)
    clash = sorted(set(ETFS) & set().union(*earlier.values()))
    if clash:
        sys.exit(f"计划里的 ETF {clash} 之前用过")
    s = cfg["sample"]
    min_start = pd.Timestamp(s["snapshot"]) - pd.DateOffset(months=round(s["min_history_years"] * 12))

    def history_start(t: str) -> pd.Timestamp | None:
        path = ev.fetch(t, data, cfg)
        return None if path is None else ev.load_prices(path)[0].index[0]

    for t in ETFS:
        start = history_start(t)
        if start is None or start > min_start:
            sys.exit(f"计划里的 ETF {t} 历史不足或取不到行情")
    quotes = screen_pool()
    stocks, excluded = pick(quotes, earlier, history_start, min_start, cfg["universe"]["exchanges"],
                            cfg["universe"]["min_dollar_volume"])
    doc = {"snapshot": s["snapshot"], "built": datetime.now().isoformat(timespec="seconds"),
           "frozen": {"commit": ev.git("rev-parse", "HEAD"), "config_sha256": config_hash(cfg),
                      "files": [str(p.relative_to(SKILL)) for p in frozen_files()], "settings": settings(cfg)},
           "rule": RULE, "criteria": [{"id": k, "text": v} for k, v in CRITERIA],
           "pool": {"source": f"yfinance {getattr(sys.modules.get('yfinance'), '__version__', '?')} screen："
                              "intradaymarketcap 800 亿 ~ 2000 亿美元、region us，按市值降序", "quotes": len(quotes)},
           "etfs": ETFS, "stocks": stocks, "excluded": excluded}
    LIST_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    return doc


def load_list(path: Path = LIST_FILE) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def tickers_of(doc: dict) -> list[str]:
    return [*doc["etfs"], *(s["ticker"] for s in doc["stocks"])]


# ---------- 跑过几次 ----------

def runs(path: Path = RUNS_FILE) -> list[dict]:
    return json.loads(path.read_text()) if path.exists() else []


def record_run(source: str, tickers: list[str], head: str, path: Path = RUNS_FILE) -> int:
    """碰一次验证集记一笔，返回记完之后一共几次。"""
    log = runs(path)
    log.append({"n": len(log) + 1, "time": datetime.now().isoformat(timespec="seconds"), "source": source,
                "head": head, "tickers": sorted(tickers)})
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(log, ensure_ascii=False, indent=1) + "\n")
    tmp.replace(path)
    return len(log)


# ---------- 判定 ----------

def criteria(pooled: dict, etf: dict, stock: dict) -> list[dict]:
    """事先定的三条，输入是 fullplan.run_group 的组结果。"""
    full, ma = pooled["runs"][fp.FULL.name], pooled["baselines"]["MA200 朴素规则"]
    ci = full["ci"]
    a = ci is not None and ci[0] > 0
    a_why = "区间算不出" if ci is None else f"平均 {full['mean_r']:+.2f}R，90% 区间 {ci[0]:+.2f} ~ {ci[1]:+.2f}"
    b = full["mar"] is not None and ma["mar"] is not None and full["mar"] >= ma["mar"]
    b_why = f"完整计划 MAR {fp.f2(full['mar'])}，MA200 朴素规则 MAR {fp.f2(ma['mar'])}"
    re_, rs = etf["runs"][fp.FULL.name]["mean_r"], stock["runs"][fp.FULL.name]["mean_r"]
    c = re_ is not None and rs is not None and np.sign(re_) == np.sign(rs) != 0
    c_why = f"ETF 组 {'—' if re_ is None else f'{re_:+.2f}R'}，个股组 {'—' if rs is None else f'{rs:+.2f}R'}"
    return [{"id": k, "text": text, "ok": bool(ok), "detail": why}
            for (k, text), ok, why in zip(CRITERIA, (a, b, c), (a_why, b_why, c_why))]


def verdict(crit: list[dict]) -> str:
    failed = [c["id"] for c in crit if not c["ok"]]
    return "新验证集支持" if not failed else f"新验证集不支持：第 {'、'.join(failed)} 条没过"


def percentile(x: float | None, xs: list[float | None]) -> float | None:
    """x 在 xs 里的百分位（严格小于的占比 + 相等的一半）。"""
    v = np.array([y for y in xs if y is not None])
    if x is None or not len(v):
        return None
    return float(((v < x).sum() + 0.5 * (v == x).sum()) / len(v))


def slice_rows(trades: list[dict], cal: list[str], cfg: dict) -> list[dict]:
    """完整计划按进场日切成 evaluation.toml 的市况切片：笔数、平均 R、90% 区间。"""
    out = []
    for name, (lo, hi) in cfg["sample"]["slices"].items():
        part = [t for t in trades if lo <= t["entry_date"] <= hi]
        rs = np.array([t["r"] for t in part])
        est = es.mean_est(rs, es.block_ids([t["entry_date"] for t in part], cal, cfg["bootstrap"]["block_days"]),
                          cfg["bootstrap"]) if len(rs) else None
        out.append({"slice": name, "trades": len(rs), "mean_r": est.point if est else None,
                    "ci": None if est is None or est.lo is None else [est.lo, est.hi]})
    return out


def random_dist(recs: dict[str, list[dict]], cal: list[str], bars: dict[str, ps.Bars], cfg: dict) -> tuple[dict, list[dict]]:
    """照 fullplan.run_group 重放完整计划和 20 次随机进场（同一个种子），返回 (完整计划的汇总, 每次随机的汇总)。"""
    pos = {d: k for k, d in enumerate(cal)}
    inval, hold = fp.inval_for(recs, pos, len(cal)), fp.hold_for(recs, pos, len(cal))
    start = min(pos[rs[0]["d"]] for rs in recs.values())
    sim_cfg = ps.Config(cost=cfg["sample"]["cost"], max_position=cfg["fullplan"]["max_position"])
    res = ps.simulate(len(cal), bars, fp.orders_for(recs, pos, bars, fp.FULL), inval, start, sim_cfg, hold)
    rng = np.random.default_rng(fp.RANDOM_SEED)
    reps = [fp.summarize(ps.simulate(len(cal), bars, fp.random_orders(res.trades, recs, pos, bars, rng), inval, start, sim_cfg, hold),
                         cal, cfg["bootstrap"]) for _ in range(fp.RANDOM_REPS)]
    return fp.summarize(res, cal, cfg["bootstrap"]), reps


# ---------- 跑 ----------

POOLED, ETF, STOCK = "合并", "ETF", "个股"


def run(out: Path, data: Path, jobs: int, rerun: bool) -> dict:
    cfg = es.load_config(ev.CONFIG)
    doc = load_list()
    if doc is None:
        sys.exit("还没有名单：先跑 holdout.py build")
    if config_hash(cfg) != doc["frozen"]["config_sha256"]:
        sys.exit("规则代码或口径和冻结时不一样，不能跑验证集")
    before = len(runs())
    if before and not rerun:
        sys.exit(f"验证集已经跑过 {before} 次；确实要再跑加 --rerun（报告会标出第几次）")
    tickers = tickers_of(doc)
    for t in tickers:
        if ev.fetch(t, data, cfg) is None:
            sys.exit(f"{t} 取不到行情")
    t0 = time.time()
    recs = fp.daily(tickers, data, out, cfg, jobs)
    t_plans = time.time() - t0
    cal, bars, sigs = fp.load_bars(tickers, data)
    cost, cap = cfg["sample"]["cost"], cfg["fullplan"]["max_position"]
    stocks = [s["ticker"] for s in doc["stocks"]]
    jobs_ = [(name, ts, {t: recs[t] for t in ts}, cal, {t: bars[t] for t in ts}, {t: sigs[t] for t in ts},
              cfg["bootstrap"], cost, cap) for name, ts in ((POOLED, tickers), (ETF, list(doc["etfs"])), (STOCK, stocks))]
    groups = dict(map(fp.run_group, jobs_))
    full, reps = random_dist({t: recs[t] for t in tickers}, cal, bars, cfg)
    if any(full[k] != groups[POOLED]["runs"][fp.FULL.name][k] for k in ("trades", "mean_r", "cagr", "mdd")):
        raise AssertionError("重放的完整计划和 run_group 的不一样")
    count = record_run("holdout.py", tickers, ev.git("rev-parse", "HEAD"))   # 结果算出来了，算看过一次
    pool = groups[POOLED]
    crit = criteria(pool, groups[ETF], groups[STOCK])
    checks = fp.card_check(pool["trades"], sigs)
    days = [r["d"] for rs in recs.values() for r in rs]
    meta = {"generated": datetime.now().isoformat(timespec="seconds"), "head": ev.git("rev-parse", "HEAD"),
            "frozen": doc["frozen"], "run": count, "n_tickers": len(tickers), "first": min(days), "last": max(days),
            "days": len(days), "checked": sum(1 for rs in recs.values() for k in range(0, len(rs), fp.CHECK_EVERY)),
            "jobs": jobs, "seconds": {"plans": round(t_plans, 1), "sim": round(time.time() - t0 - t_plans, 1)},
            "starts": {t: rs[0]["d"] for t, rs in recs.items()}}
    result = {"meta": meta, "list": doc, "criteria": crit, "verdict": verdict(crit),
              "random_pctl": {"mean_r": percentile(full["mean_r"], [r["mean_r"] for r in reps]),
                              "mar": percentile(full["mar"], [r["mar"] for r in reps]),
                              "reps": [{k: r[k] for k in ("trades", "mean_r", "mar")} for r in reps]},
              "slices": {g: slice_rows(groups[g]["trades"], cal, cfg) for g in groups},
              "groups": groups, "card_check": checks}
    return result


# ---------- 报告 ----------

def crit_table(crit: list[dict]) -> list[str]:
    return ["| 条 | 标准 | 结果 | 数字 |", "|---|---|---|---|",
            *[f"| {c['id']} | {c['text']} | {'过' if c['ok'] else '**没过**'} | {c['detail']} |" for c in crit]]


def halves_rows(groups: dict) -> list[str]:
    out = ["| 组 | 2013–2019 | 2020–2026 |", "|---|---:|---:|"]
    for g, x in groups.items():
        cells = []
        for h, _ in fp.SPLITS:
            s = x["halves"][fp.FULL.name][h]
            ci = "区间 —" if s["ci"] is None else f"{s['ci'][0]:+.2f} ~ {s['ci'][1]:+.2f}"
            cells.append("—" if s["mean_r"] is None else f"{s['mean_r']:+.2f}R（{ci}，{s['trades']} 笔）")
        out.append(f"| {g} | {cells[0]} | {cells[1]} |")
    return out


def slices_rows(slices: dict) -> list[str]:
    names = [s["slice"] for s in next(iter(slices.values()))]
    out = ["| 组 | " + " | ".join(names) + " |", "|---|" + "---:|" * len(names)]
    for g, rows in slices.items():
        out.append(f"| {g} | " + " | ".join("—" if s["mean_r"] is None else f"{s['mean_r']:+.2f}R（{s['trades']} 笔）"
                                            for s in rows) + " |")
    return out


LIMITS = [
    "**幸存者偏差**：个股按 2026-11-20 的市值挑，是今天还活着、还够大的公司；2013 年时它们不一定在这个市值档。ETF 没有这个问题，所以 ETF 组单列。",
    "**分叉路径**：P25 的改动（到目标位、中长线完好就继续拿）是看了核心名单的结果之后才决定的，核心名单上的提升偏乐观。"
    "这份新验证集在那之后才按规则生成，没有参与任何决定，是干净的检验。",
    "**只跑一次**：名单、口径、判定标准都在跑之前提交（见 references/holdout.json 的提交记录）。之后在这批票上调任何东西，这份检验就作废；"
    "工作台回测碰到这些票会标出来并计数（references/holdout-runs.json）。",
    "**样本不独立**：同一天几十只票一起动。区间用 60 个交易日一块的日期区块自助法，已算进这种相关，但区块之间仍不完全独立。",
    "**随机进场只有 20 次**：和核心名单报告同一个口径（种子 11），百分位的分辨率是 5%。",
    "**其余口径照核心名单报告**：止损按收盘、第二天开盘走；回放没有小时线，要看小时线的进场当作满足；只用第一目标；每边 0.05% 成本、含分红；只做多。",
    "**上市晚的票决定点少**：按标准 3 年口径，上市不满 3 年之前没有计划，这些票只贡献后面几年的交易。",
]


def pctl(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:.0f}"


def render(r: dict) -> str:
    m, doc, g = r["meta"], r["list"], r["groups"]
    pool, full = g[POOLED], g[POOLED]["runs"][fp.FULL.name]
    rnd = r["random_pctl"]
    starts = m["starts"]
    late = sorted((t for t, d in starts.items() if d > doc["frozen"]["settings"]["first_decision"]), key=lambda t: starts[t])
    out = [f"# 新验证集：完整计划的最终检验（{m['first']} ~ {m['last']}）", "",
           "照结论卡片的完整计划，在一批从没在任何评估或回测里出现过的品种上跑一次。只作风险提示，不改定位：归雁是把双均线交易系统用到真实交易上的工具。", "",
           "## 冻结", "",
           f"- 代码：origin/main `{doc['frozen']['commit']}`；记下这次运行时 HEAD `{m['head'][:12]}`（只多了名单、锁和本脚本；开跑前核对过冻结哈希一致）",
           f"- 口径哈希（sha256，{len(doc['frozen']['files'])} 个文件：规则脚本和 evaluation.toml，加执行口径）：`{doc['frozen']['config_sha256']}`",
           "- 执行口径：每笔 1% 风险、按收盘止损、单票 25% 上限、盈亏比 ≥ 3:1 才做、挂第一目标并用新 P25、不设止损下限、每边 0.05%",
           f"- 名单生成：{doc['built']}（快照日 {doc['snapshot']}），提交在跑结果之前",
           f"- 这是第 **{m['run']}** 次跑这批票" + ("" if m["run"] == 1 else "（**不是第一次，结论打折**）"), "",
           "## 事先定的判定（看结果之前写下）", "", *[f"{k}. {v}" for k, v in CRITERIA], "",
           "三条都过，写\"新验证集支持\"；否则照实写哪条没过。", "",
           "## 名单和怎么来的", "", *[f"- {x}" for x in doc["rule"]], "",
           f"候选池 {doc['pool']['quotes']} 条报价（{doc['pool']['source']}）。", "",
           f"**ETF {len(doc['etfs'])} 只**：{' '.join(doc['etfs'])}", "",
           f"**个股 {len(doc['stocks'])} 只**（按市值）：", "", "| 票 | 名字 | 市值（亿美元） | 第一根 K 线 | 第一个决定点 |", "|---|---|---:|---|---|",
           *[f"| {s['ticker']} | {s['name']} | {s['cap'] / 1e8:,.0f} | {s['first_bar']} | {starts.get(s['ticker'], '—')} |" for s in doc["stocks"]], "",
           "去掉的（只列在 800 亿 ~ 2000 亿、美国交易所挂牌的里面）：", "", "| 票 | 市值（亿美元） | 原因 |", "|---|---:|---|",
           *[f"| {e['ticker']} | {e['cap'] / 1e8:,.0f} | {e['reason']} |" for e in doc["excluded"]], ""]
    if late:
        out += ["决定点晚于 2013-01-02 的（上市不满 3 年之前没有计划）：" + "，".join(f"{t} {starts[t]}" for t in late) + "。", ""]
    out += ["## 结论", "", f"**{r['verdict']}**", "", *crit_table(r["criteria"]), "",
            f"- 合并组 {len(pool['tickers'])} 只，完整计划 {full['trades']} 笔，平均 {fp.rr_cell(full)}，"
            f"年化 {fp.pc(full['cagr'])}、最大回撤 {fp.pc(full['mdd'])}、MAR {fp.f2(full['mar'])}。",
            f"- 随机进场（同仓位、同离场，{fp.RANDOM_REPS} 次）：完整计划的平均 R 排在第 {pctl(rnd['mean_r'])} 百分位，"
            f"MAR 排在第 {pctl(rnd['mar'])} 百分位。", ""]
    for name in (POOLED, ETF, STOCK):
        x = g[name]
        out += [f"### {name}（{len(x['tickers'])} 只，{x['start']} ~ {x['end']}）", "", *fp.group_table(x), ""]
    out += ["## 分段", "", "前后两段（完整计划，按进场日）：", "", *halves_rows(g), "",
            "市况切片（evaluation.toml 的 slices，完整计划，按进场日）：", "", *slices_rows(r["slices"]), "",
            "## 和结论卡片对一遍", "",
            f"抽 {len(r['card_check'])} 笔，用 `dma_analyze.py --csv --asof --json` 重算信号日的计划，进场、止损、第一目标、盈亏比结论都要和回测下的单一样：",
            "", "| 票 | 信号日 | 卡片：进场 / 止损 / 第一目标 / 结论 | 回测的单 | 一致 |", "|---|---|---|---|---|"]
    for c in r["card_check"]:
        t, k = c["trade"], c["card"]
        out.append(f"| {t['ticker']} | {t['signal_date']} | {k['entry']:.2f} / {k['stop']:.2f} / {k['t1']:.2f} / {k['verdict']} | "
                   f"{t['plan_entry']:.2f} / {t['stop']:.2f} / {t['target']:.2f} | {'是' if c['same'] else '**否**'} |")
    ts = pool["trades"]
    out += ["", f"决定点 {m['days']} 个，其中 {m['checked']} 个和完整分析逐字段对过交易计划。计划计算 {m['seconds']['plans']:.0f}s（{m['jobs']} 个进程），"
            f"回测 {m['seconds']['sim']:.0f}s。", "",
            "R 最高的 10 笔：", "", fp.TRADE_HEAD, *map(fp.trade_line, sorted(ts, key=lambda t: -t["r"])[:10]), "",
            "R 最低的 10 笔：", "", fp.TRADE_HEAD, *map(fp.trade_line, sorted(ts, key=lambda t: t["r"])[:10]), "",
            "## 不能当真的地方", "", *[f"- {x}" for x in LIMITS], ""]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=("build", "run", "render"))
    p.add_argument("--out", type=Path, required=True, help="reports/replay：读 eval/universe-<快照>.json，写报告和每天计划的缓存")
    p.add_argument("--data", type=Path, help="行情，默认 <out>/data/eval")
    p.add_argument("--jobs", type=int, default=14)
    p.add_argument("--rerun", action="store_true", help="验证集已经跑过还要再跑")
    a = p.parse_args()
    data = a.data or a.out / "data" / "eval"
    if a.cmd == "build":
        doc = build(a.out, data)
        print(json.dumps({"etfs": doc["etfs"], "stocks": [s["ticker"] for s in doc["stocks"]],
                          "excluded": len(doc["excluded"])}, ensure_ascii=False))
        return
    if a.cmd == "render":                     # 只按存下的 JSON 重写报告，不重跑、不计数
        (a.out / f"{STEM}.md").write_text(render(json.loads((a.out / f"{STEM}.json").read_text())))
        return
    result = run(a.out, data, a.jobs, a.rerun)
    (a.out / f"{STEM}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str) + "\n")
    md = render(json.loads((a.out / f"{STEM}.json").read_text()))
    (a.out / f"{STEM}.md").write_text(md)
    print(md)
    if not all(c["same"] for c in result["card_check"]):
        sys.exit("有交易和结论卡片对不上，见报告")


if __name__ == "__main__":
    main()
