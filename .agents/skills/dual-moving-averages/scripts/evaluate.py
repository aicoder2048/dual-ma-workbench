#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
#     "yfinance",
# ]
# ///
"""评估双均线方法的六条主张（H1–H6），门槛全在 references/evaluation.toml。

用法：
  uv run evaluate.py                       # 开发集，全部主张
  uv run evaluate.py --only H3             # 只跑一条
  uv run evaluate.py --tickers NVDA,TSLA   # 换品种试（不算开发集，也不算验证集）
  uv run evaluate.py --holdout             # 开发集 + 验证集，写最终报告。验证集只该跑一次，跑几次都记下来
  uv run evaluate.py --verify              # 核对：规则代码没改、抽查等于 dma_analyze.py --csv --asof、不偷看未来
  uv run evaluate.py --compare <上一份报告的 json>

- 行情：yfinance 日线（2010 起），开高低收用拆股复权价（出信号，和 skill 一致），收益用含分红的复权价。
  缓存在 --data（默认 reports/replay/data/eval/）。
- 每天的分析：切出当天往前 3 年（周线用往前 5 年，和实时取数一样），逐日跑轻量路径（类型、阶段、横盘箱体、周线排列，H3、H5 用），
  每 decision_every 天跑一次完整分析（backtest.analyze_on，等于 dma_analyze.py --csv --asof；H1、H2、H4、H6 用）。
  完整分析的那天，轻量路径的结果必须和完整分析一字不差，不一样就停。
- 每只票的结果缓存在 <out>/eval/daily/<票>.jsonl，规则代码或行情变了自动重算。只改门槛时几秒出结果。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
import zlib
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import backtest as bt  # noqa: E402
import dma_analyze as dma  # noqa: E402
import evalstats as es  # noqa: E402
import regime as rg  # noqa: E402
import rules as rl  # noqa: E402
from indicators import add_indicators  # noqa: E402
from projection import SOLVE_DAYS, _default_targets  # noqa: E402
from structure import find_structure  # noqa: E402
from weekly import weekly_json  # noqa: E402

PROJECT = SKILL.parents[2]
CONFIG = SKILL / "references" / "evaluation.toml"
OHLCV = ["Open", "High", "Low", "Close", "Volume"]
RECORD_VERSION = "1"
HYPS = ("H1", "H2", "H3", "H4", "H5", "H6")
CHUNK = 250


# ---------- 行情 ----------

def fetch(ticker: str, data: Path, cfg: dict, refresh: bool = False) -> Path | None:
    """yfinance 不复权分红的日线（Close 只拆股复权）+ Adj Close，从 data_from 取到 snapshot 前一天。取不到返回 None。"""
    path = data / f"{ticker}.csv"
    if path.exists() and not refresh:
        return path
    import yfinance as yf

    s = cfg["sample"]
    df = yf.download(ticker, start=s["data_from"], end=s["snapshot"], auto_adjust=False, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if df.empty or not set(OHLCV + ["Adj Close"]) <= set(df.columns):
        return None
    df = df[OHLCV + ["Adj Close"]].dropna()
    df.index.name = "Date"
    data.mkdir(parents=True, exist_ok=True)
    df.to_csv(path)
    return path


def load_prices(path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(出信号用的拆股复权开高低收量, 算收益用的含分红复权开盘、收盘)。"""
    raw = pd.read_csv(path, parse_dates=["Date"]).set_index("Date").sort_index()
    factor = raw["Adj Close"] / raw["Close"]
    ret = pd.DataFrame({"Open": raw["Open"] * factor, "Close": raw["Adj Close"]}, index=raw.index)
    return raw[OHLCV].copy(), ret


# ---------- 品种 ----------

def screen(cfg: dict) -> tuple[list[dict], list[dict]]:
    """yfinance 筛市值 ≥ C_min_cap 的美股；返回 (留下的, 去掉的 + 原因)。"""
    import yfinance as yf
    from yfinance import EquityQuery

    u = cfg["universe"]
    q = EquityQuery("and", [EquityQuery("gte", ["intradaymarketcap", u["C_min_cap"]]),
                            EquityQuery("eq", ["region", "us"])])
    quotes, offset = [], 0
    while True:
        r = yf.screen(q, offset=offset, size=250, sortField="intradaymarketcap", sortAsc=False)
        quotes += r["quotes"]
        offset += len(r["quotes"])
        if not r["quotes"] or offset >= r.get("total", 0):
            break
    kept, dropped, seen = [], [], {}
    for x in quotes:
        sym, name = x["symbol"], x.get("shortName") or x["symbol"]
        dollar = (x.get("regularMarketPrice") or 0) * (x.get("averageDailyVolume3Month") or 0)
        if x.get("quoteType") != "EQUITY" or x.get("exchange") not in u["exchanges"]:
            continue                       # 场外、优先股：不是要找的那种，不列
        if not x.get("marketCap"):
            continue
        if dollar < u["min_dollar_volume"]:
            dropped.append({"ticker": sym, "reason": f"日均成交额 {dollar / 1e6:.1f} 百万美元，市值数据存疑"})
            continue
        row = {"ticker": sym, "name": name, "cap": x["marketCap"]}
        name = sym.split("-")[0] if "-" in sym else name     # BRK-A、BRK-B 名字不同，代码根相同
        if name in seen:                   # 同一家公司的几类股：按 share_class_prefer，没写就留市值大的
            other = seen[name]
            keep_new = sym in u["share_class_prefer"]
            loser = other if keep_new else row
            dropped.append({"ticker": loser["ticker"], "reason": f"和 {(row if keep_new else other)['ticker']} 是同一家公司"})
            if keep_new:
                kept.remove(other)
                kept.append(row)
                seen[name] = row
            continue
        seen[name] = row
        kept.append(row)
    for row in kept:
        row["sector"] = yf.Ticker(row["ticker"]).info.get("sector")
    return kept, dropped


def max_drop(close: pd.Series, since: str) -> float:
    c = close[close.index >= pd.Timestamp(since)]
    return float((c / c.cummax() - 1).min()) if len(c) else 0.0


def build_universe(cfg: dict, data: Path, refresh: bool) -> dict:
    """方案 2.1：A 照列；D 候选里 2016 年起跌掉一半以上的；B = 方案列的 + 行业是科技 / 通信服务的大市值；
    C = 其余市值 ≥ 2000 亿的。D 优先（单列，不并入 B、C），再 B，再 C。每组按代码字母序，奇数位开发集、偶数位验证集。"""
    u, s = cfg["universe"], cfg["sample"]
    excluded = [{"ticker": t, "group": "—", "reason": "历史不足（2026 年才上市）"} for t in u["too_short"]]
    screened, dropped = screen(cfg)
    min_start = pd.Timestamp(s["snapshot"]) - pd.DateOffset(months=round(s["min_history_years"] * 12))

    def usable(t: str, group: str) -> bool:
        path = fetch(t, data, cfg, refresh)
        if path is None:
            excluded.append({"ticker": t, "group": group, "reason": "取不到行情（可能已退市）"})
            return False
        start = load_prices(path)[0].index[0]
        if start > min_start:
            excluded.append({"ticker": t, "group": group, "reason": f"历史不足（{start.date()} 起）"})
            return False
        return True

    groups: dict[str, list[str]] = {"A": [t for t in u["A"] if usable(t, "A")]}
    d = []
    for t in u["D_candidates"]:
        if not usable(t, "D"):
            continue
        drop = max_drop(load_prices(data / f"{t}.csv")[0]["Close"], u["D_since"])
        if drop <= -u["D_min_drop"]:
            d.append(t)
        else:
            excluded.append({"ticker": t, "group": "D", "reason": f"{u['D_since'][:4]} 年起最大跌幅 {drop:.0%}，不到一半"})
    groups["D"] = d
    taken = set(groups["A"]) | set(d) | set(u["too_short"])
    b = [t for t in u["B_seed"] if t not in taken]
    b += [r["ticker"] for r in screened if r["sector"] in u["B_sectors"] and r["ticker"] not in taken | set(b)]
    groups["B"] = [t for t in b if usable(t, "B")]
    taken |= set(b)
    groups["C"] = [t for t in (r["ticker"] for r in screened if r["ticker"] not in taken) if usable(t, "C")]
    split = {}
    for ts in groups.values():
        for k, t in enumerate(sorted(ts)):
            split[t] = "dev" if k % 2 == 0 else "holdout"
    return {"snapshot": s["snapshot"], "groups": {g: sorted(ts) for g, ts in groups.items()}, "split": split,
            "excluded": excluded, "screen_dropped": dropped,
            "screened": [{k: r[k] for k in ("ticker", "cap", "sector")} for r in screened]}


def universe(cfg: dict, out: Path, data: Path, rebuild: bool, refresh: bool) -> dict:
    path = out / "eval" / f"universe-{cfg['sample']['snapshot']}.json"
    if path.exists() and not rebuild:
        return json.loads(path.read_text())
    u = build_universe(cfg, data, refresh)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(u, ensure_ascii=False, indent=1) + "\n")
    return u


# ---------- 每天的分析 ----------

def regime_fields(reg: dict, key: str, weekly: dict) -> dict:
    """轻量路径和完整分析共有的那部分：类型、阶段、过渡名、打法键、横盘箱体、周线排列。"""
    r = reg["range"] or {}
    return {"type": reg["type"], "stage": reg["stage"], "transition": reg["transition"], "name": reg["name"],
            "key": key, "range_days": r.get("days"), "box_high": r.get("box_high"), "box_low": r.get("box_low"),
            "w_ma": weekly.get("arr_ma"), "w_ema": weekly.get("arr_ema")}


def light(cut: pd.DataFrame, history: pd.DataFrame) -> dict:
    """轻量路径：只算类型 × 阶段和周线，步骤和 dma_analyze.analyze 里同名的几行一样（不跑推演、规则）。"""
    df = add_indicators(cut.copy())
    row = df.iloc[-1]
    bias = df["BIAS20"].dropna()
    reg, _ = rg.classify(df, find_structure(df), float((bias <= row["BIAS20"]).mean()))
    return regime_fields(dma._plain(asdict(reg)), rl.play_key(reg), weekly_json(history))


def outcomes(cut: pd.DataFrame, px: pd.DataFrame, i: int, solves: list[dict]) -> list[list]:
    """推演求解的每个目标，K 天内在真实行情里发没发生。只在分析算完之后读第 i 根之后的行情。"""
    df = add_indicators(cut.copy())
    plan = [(e, happen, k) for e, happen in _default_targets(df) for k in SOLVE_DAYS]
    if [e.describe() for e, _, _ in plan] != [s["event"] for s in solves]:
        raise AssertionError(f"{px.index[i].date()}：求解目标和分析结果对不上")
    future = px["Close"].iloc[i + 1:i + 1 + max(SOLVE_DAYS)]
    ext = add_indicators(pd.concat([df[["Close"]], future.to_frame()])) if len(future) else None
    rows = []
    for (e, happen, k), s in zip(plan, solves):
        hit = None if len(future) < k else bool(e.state(ext.iloc[:len(df) + k], k).any())
        rows.append([e.kind.value, e.fast, e.slow, e.line, happen, k, s["status"], s["pct"], s["side"], hit])
    return rows


def analyze_day(px: pd.DataFrame, i: int, ticker: str, full: bool) -> dict:
    cut = bt.cut_at(px, i)
    if cut.index[-1] != px.index[i] or len(cut) > i + 1:
        raise AssertionError(f"{ticker} {px.index[i].date()}：分析用到了之后的行情")
    rec = {"i": i, "d": str(px.index[i].date()), **light(cut, bt.history_at(px, i))}
    if not full:
        return rec
    a = bt.analyze_on(px, i, ticker)
    same = regime_fields(a["regime"], a["play"]["key"], a["weekly"])
    if same != {k: rec[k] for k in same}:
        raise AssertionError(f"{ticker} {rec['d']}：轻量路径 {rec} 和完整分析 {same} 不一致")
    rec.update(lean=a["lean"]["label"], lean_score=a["lean"]["score"],
               rules={r["id"]: r["status"] for r in a["rules"]},
               solves=outcomes(cut, px, i, a["projection"]["solves"]))
    return rec


def run_chunk(job: tuple[str, str, int, int, int, int]) -> tuple[str, int, list[dict]]:
    ticker, csv, lo, hi, first, every = job
    px, _ = load_prices(Path(csv))
    return ticker, lo, [analyze_day(px, i, ticker, (i - first) % every == 0) for i in range(lo, hi)]


def first_index(px: pd.DataFrame, cfg: dict) -> int:
    """第一个决定点：不早于 first_decision，且往前有满 3 年的数据（cut_at 不报错）。"""
    i = int(px.index.searchsorted(pd.Timestamp(cfg["sample"]["first_decision"])))
    while i < len(px):
        try:
            bt.cut_at(px, i)
            return i
        except ValueError:
            i += 1
    raise ValueError("没有满 3 年历史的交易日")


def rule_files(cfg: dict) -> list[Path]:
    skip = set(cfg["freeze"]["eval_files"])
    return sorted(p for p in SCRIPTS.glob("*.py") if p.name not in skip)


def fingerprint(csv: Path, cfg: dict) -> str:
    h = hashlib.sha256(f"{RECORD_VERSION},{cfg['sample']['first_decision']},{cfg['sample']['decision_every']}".encode())
    for p in rule_files(cfg):
        h.update(p.read_bytes())
    h.update(csv.read_bytes())
    return h.hexdigest()


def daily(tickers: list[str], data: Path, out: Path, cfg: dict, jobs: int) -> dict[str, list[dict]]:
    """每只票每天的记录；缓存对得上就读缓存，否则切块并行算。"""
    cache = out / "eval" / "daily"
    cache.mkdir(parents=True, exist_ok=True)
    got: dict[str, list[dict]] = {}
    todo: list[tuple[str, str, int, int, int, int]] = []
    fps = {}
    for t in tickers:
        csv = data / f"{t}.csv"
        fps[t] = fingerprint(csv, cfg)
        path = cache / f"{t}.jsonl"
        if path.exists():
            head, *rows = path.read_text().splitlines()
            if json.loads(head).get("fingerprint") == fps[t]:
                got[t] = [json.loads(r) for r in rows]
                continue
        px, _ = load_prices(csv)
        first = first_index(px, cfg)
        todo += [(t, str(csv), lo, min(lo + CHUNK, len(px)), first, cfg["sample"]["decision_every"])
                 for lo in range(first, len(px), CHUNK)]
    if not todo:
        return got
    parts: dict[str, dict[int, list[dict]]] = defaultdict(dict)
    need = defaultdict(int)
    for t, *_ in todo:
        need[t] += 1
    t0 = time.time()
    print(f"分析 {len(need)} 只票，{len(todo)} 块，{jobs} 个进程", file=sys.stderr)
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(run_chunk, j) for j in todo]
        for n, f in enumerate(as_completed(futs), 1):
            t, lo, rows = f.result()
            parts[t][lo] = rows
            if len(parts[t]) == need[t]:
                recs = [r for k in sorted(parts[t]) for r in parts[t][k]]
                (cache / f"{t}.jsonl").write_text("\n".join([json.dumps({"fingerprint": fps[t]})]
                                                            + [json.dumps(r, ensure_ascii=False) for r in recs]) + "\n")
                got[t] = recs
                print(f"  {t} 完成（{len(recs)} 天），{n}/{len(todo)} 块，{time.time() - t0:.0f}s", file=sys.stderr)
    return got


# ---------- 样本范围 ----------

@dataclass(frozen=True)
class Scope:
    name: str
    tickers: frozenset[str]
    lo: str = "0000"
    hi: str = "9999"


DEV, HO = "开发集", "验证集"


def scopes(u: dict, cfg: dict, tickers: list[str], holdout: bool, custom: bool) -> list[Scope]:
    gof = {t: g for g, ts in u["groups"].items() for t in ts}
    group = lambda t: gof.get(t, "A" if t in cfg["universe"]["A"] else "C")   # noqa: E731

    def sets(ts: list[str]) -> dict[str, frozenset[str]]:
        return {"all": frozenset(t for t in ts if group(t) != "D"), "A": frozenset(t for t in ts if group(t) == "A"),
                "B+C": frozenset(t for t in ts if group(t) in ("B", "C")), "D": frozenset(t for t in ts if group(t) == "D")}

    dev = sets(tickers if custom else [t for t in tickers if u["split"].get(t) == "dev"])
    (h1lo, h1hi), (h2lo, h2hi) = cfg["sample"]["halves"]
    out = [Scope(DEV, dev["all"]), Scope(f"前半 {h1lo[:4]}–{h1hi[:4]}", dev["all"], h1lo, h1hi),
           Scope(f"后半 {h2lo[:4]}–{h2hi[:4]}", dev["all"], h2lo, h2hi),
           Scope("A", dev["A"]), Scope("B+C", dev["B+C"]), Scope("D", dev["D"])]
    out += [Scope(name, dev["all"], lo, hi) for name, (lo, hi) in cfg["sample"]["slices"].items()]
    if holdout:
        ho = sets([t for t in tickers if u["split"].get(t) == "holdout"])
        out += [Scope(HO, ho["all"]), Scope(f"{HO} A", ho["A"]), Scope(f"{HO} B+C", ho["B+C"]), Scope(f"{HO} D", ho["D"])]
    return out


def halves_of(sc: list[Scope]) -> list[Scope]:
    return [s for s in sc if s.name.startswith(("前半", "后半"))]


def by_name(sc: list[Scope], name: str) -> Scope | None:
    return next((s for s in sc if s.name == name), None)


# ---------- 数据表 ----------

def forward_open(o: np.ndarray, h: int) -> np.ndarray:
    """第 i 天收盘后的信号，次日开盘买、h 根后开盘卖（和 trades.forward 一样）；不够的为 nan。"""
    out = np.full(len(o), np.nan)
    n = len(o) - 1 - h
    if n > 0:
        out[:n] = o[1 + h:1 + h + n] / o[1:1 + n] - 1
    return out


def decision_table(recs: dict[str, list[dict]], rets: dict[str, pd.DataFrame], cfg: dict) -> pd.DataFrame:
    hs = sorted({cfg["H1"]["horizon"], cfg["H2"]["horizon"], cfg["H6"]["horizon"], *map(int, cfg["H1"]["aux_horizons"])})
    rows = []
    for t, rs in recs.items():
        o, c = rets[t]["Open"].to_numpy(), rets[t]["Close"].to_numpy()
        fw = {h: forward_open(o, h) for h in hs}
        lr = pd.Series(np.log(c)).diff()
        vol = lr.rolling(20).std().shift(-20).to_numpy()   # 第 i+1 ~ i+20 天的日收益波动
        for r in rs:
            if "lean" not in r:
                continue
            i = r["i"]
            rows.append({"ticker": t, "date": r["d"], "lean": r["lean"], "type": r["type"], "stage": r["stage"],
                         "transition": r["transition"], "vol20": vol[i], **{f"fwd{h}": fw[h][i] for h in hs}})
    return pd.DataFrame(rows)


def in_scope(df: pd.DataFrame, s: Scope, date_col: str = "date") -> pd.DataFrame:
    return df[df["ticker"].isin(s.tickers) & (df[date_col] >= s.lo) & (df[date_col] <= s.hi)]


# ---------- 主张 ----------

def est_json(e: es.Est) -> dict:
    return asdict(e)


class Ctx:
    def __init__(self, cfg, recs, rets, sigs, sc, calendar, holdout):
        self.cfg, self.recs, self.rets, self.sigs, self.sc, self.holdout = cfg, recs, rets, sigs, sc, holdout
        self.bc = cfg["bootstrap"]
        self.calendar = calendar
        self.dec = decision_table(recs, rets, cfg)

    def blocks(self, dates) -> np.ndarray:
        return es.block_ids(list(dates), self.calendar, self.bc["block_days"])

    def ex(self, s: Scope, col: str) -> pd.DataFrame:
        """范围内的决定点，col 有值的；ex 列 = col 减去同一只票（范围内）的平均。"""
        d = in_scope(self.dec, s)
        d = d[d[col].notna()].copy()
        d["ex"] = es.excess(d[col], d["ticker"]) if len(d) else []
        return d

    def verdict(self, sign: int, ests: dict[str, es.Est], hyp: str, extra_ok: bool = True,
                sample_ok: bool | None = None) -> str:
        dev = ests[DEV]
        ok = es.enough(dev, self.bc) if sample_ok is None else sample_ok
        return es.verdict_effect(sign, dev, [ests[s.name] for s in halves_of(self.sc)], ests["A"], ests["B+C"],
                                 ests.get(HO) if self.holdout else None, self.cfg[hyp]["min_meaningful"],
                                 self.cfg["verdict"]["holdout_min_ratio"], extra_ok, ok)


def diff_by(ctx: Ctx, s: Scope, col: str, a_mask, b_mask) -> es.Est:
    d = ctx.ex(s, col)
    a, b = d[a_mask(d)], d[b_mask(d)]
    return es.diff_est(a["ex"], ctx.blocks(a["date"]), b["ex"], ctx.blocks(b["date"]), ctx.bc)


def h1(ctx: Ctx) -> dict:
    c = ctx.cfg["H1"]
    col = f"fwd{c['horizon']}"
    bull, bear = (lambda d: d["lean"].isin(c["bull"])), (lambda d: d["lean"].isin(c["bear"]))
    ests = {s.name: diff_by(ctx, s, col, bull, bear) for s in ctx.sc}
    dev = by_name(ctx.sc, DEV)
    tiers = ctx.ex(dev, col).groupby("lean")["ex"]
    aux = ["五档各自的平均超额（开发集，20 日）：" + "，".join(
        f"{lab} {pct(tiers.get_group(lab).mean())}（{len(tiers.get_group(lab))}）"
        for lab in dma.LEAN_LABELS if lab in tiers.groups)]
    for h in c["aux_horizons"]:
        e = diff_by(ctx, dev, f"fwd{int(h)}", bull, bear)
        aux.append(f"{int(h)} 日口径：偏多 − 偏空 {pct(e.point)}（{ci(e)}）")
    d = in_scope(ctx.dec, dev)
    d = d[d[col].notna()]
    for name, m in (("偏多", bull(d)), ("偏空", bear(d))):
        aux.append(f"命中率：{name}之后 20 日上涨的比例 {d[m][col].gt(0).mean():.0%}（全部决定点 {d[col].gt(0).mean():.0%}）")
    return {"id": "H1", "claim": "模糊判断：偏多之后跑赢，偏空之后跑输", "metric": "（明显偏多 + 偏多）− （明显偏空 + 偏空）的 20 日平均超额",
            "unit": "pct", "sign": 1, "ests": ests, "verdict": ctx.verdict(1, ests, "H1"), "aux": aux}


def h2(ctx: Ctx) -> dict:
    c = ctx.cfg["H2"]
    col = f"fwd{c['horizon']}"
    up, down = (lambda d: d["type"].isin(c["up_types"])), (lambda d: d["type"].isin(c["down_types"]))
    ests = {s.name: diff_by(ctx, s, col, up, down) for s in ctx.sc}
    dev = by_name(ctx.sc, DEV)
    d = in_scope(ctx.dec, dev)
    d = d[d["vol20"].notna()].copy()
    d["vx"] = d["vol20"] / d.groupby("ticker")["vol20"].transform("mean") - 1
    aux = []
    for t in ("加速上涨", "加速下跌", "横盘", "稳定上涨", "稳定下跌"):
        g = d[d["type"] == t]
        if len(g):
            e = es.mean_est(g["vx"], ctx.blocks(g["date"]), ctx.bc)
            aux.append(f"{t}之后 20 日波动比同票平均 {pct(e.point)}（{ci(e)}，{len(g)} 点）")
    aux.append("类型 × 阶段的 20 日平均超额（开发集）：" + "，".join(
        f"{n} {pct(g['ex'].mean())}（{len(g)}）" for n, g in ctx.ex(dev, col).assign(
            n=lambda x: x["type"].fillna(x["transition"]) + "·" + x["stage"].fillna("—")).groupby("n") if len(g) >= 30))
    return {"id": "H2", "claim": "类型决定之后的方向：稳定上涨跑赢稳定下跌", "metric": "稳定上涨（含回撤中）− 稳定下跌（含反弹中）的 20 日平均超额",
            "unit": "pct", "sign": 1, "ests": ests, "verdict": ctx.verdict(1, ests, "H2"), "aux": aux}


def h6(ctx: Ctx) -> dict:
    c = ctx.cfg["H6"]
    col = f"fwd{c['horizon']}"

    def pick(d):
        return d["transition"].isin(c["transitions"]) | (d["type"].isin(c["down_types"]) & (d["stage"] == c["stage"]))

    ests = {}
    for s in ctx.sc:
        d = ctx.ex(s, col)
        g = d[pick(d)]
        ests[s.name] = es.mean_est(g["ex"], ctx.blocks(g["date"]), ctx.bc)
    dev = ctx.ex(by_name(ctx.sc, DEV), col)
    aux = []
    for name, m in (("空头结构反弹中", dev["transition"].isin(c["transitions"])),
                    ("稳定 / 加速下跌·反弹中", dev["type"].isin(c["down_types"]) & (dev["stage"] == c["stage"]))):
        g = dev[m]
        e = es.mean_est(g["ex"], ctx.blocks(g["date"]), ctx.bc)
        aux.append(f"{name}：{pct(e.point)}（{ci(e)}，{len(g)} 点）")
    return {"id": "H6", "claim": "假动作：排列不合理时的反弹撑不住", "metric": "空头结构反弹中、下跌·反弹中之后 20 日的平均超额",
            "unit": "pct", "sign": -1, "ests": ests, "verdict": ctx.verdict(-1, ests, "H6"), "aux": aux}


EVENT_COLS = ["kind", "fast", "slow", "line", "happen", "K", "status", "pct", "side", "hit"]


def event_table(recs: dict[str, list[dict]]) -> pd.DataFrame:
    rows = [{"ticker": t, "date": r["d"], **dict(zip(EVENT_COLS, s))} for t, rs in recs.items() for r in rs
            if "solves" in r for s in r["solves"]]
    ev = pd.DataFrame(rows)
    ev = ev[ev["hit"].notna()].copy()
    ev["hit"] = ev["hit"].astype(float)
    level = ev["status"] == "有临界价位"
    # 持平在现价时目标成不成立：side 以上 → 现价在临界价位之上（pct ≤ 0）
    at_flat = np.where(ev["side"] == "以上", ev["pct"] <= 0, ev["pct"] >= 0)
    # 求"发生"且持平就成立，或求"不发生"且持平不成立：都是"不动就会发生，要涨（跌）|pct| 才能避免"
    ev["inevitable"] = level & np.where(ev["happen"], at_flat, ~at_flat)
    ev["x"] = ev["pct"].abs()
    ev["key"] = [f"{k}{f}/{s}{ln}K{d}" for k, f, s, ln, d in zip(ev["kind"], ev["fast"], ev["slow"].fillna(0).astype(int), ev["line"], ev["K"])]
    return ev


def h4(ctx: Ctx) -> dict:
    c = ctx.cfg["H4"]
    lo, hi = c["buckets"]
    ev = event_table(ctx.recs)
    inv = ev[ev["inevitable"]]
    top, low = (lambda d: d[d["x"] > hi]), (lambda d: d[d["x"] < lo])
    ests, rates = {}, {}
    for s in ctx.sc:
        d = in_scope(inv, s)
        a, b = top(d), low(d)
        ests[s.name] = es.diff_est(a["hit"], ctx.blocks(a["date"]), b["hit"], ctx.blocks(b["date"]), ctx.bc)
        rates[s.name] = es.mean_est(a["hit"], ctx.blocks(a["date"]), ctx.bc)
    r = rates[DEV]
    extra = r.n >= c["min_events"] and r.point >= c["min_rate"] and ests[DEV].point >= c["min_gap"]
    dev = by_name(ctx.sc, DEV)
    d_all, d = in_scope(ev, dev), in_scope(inv, dev)
    base = d_all.groupby("key")["hit"].mean()
    aux = [f"X > {hi:g}% 那一档的发生率：{pp(r.point)}（{ci(r, pp)}，{r.n} 次）。判定要 ≥ {pp(c['min_rate'])}，且比 X < {lo:g}% 高 {pp(c['min_gap'])} 以上"]
    for name, g in ((f"X < {lo:g}%", low(d)), (f"{lo:g}–{hi:g}%", d[(d["x"] >= lo) & (d["x"] <= hi)]), (f"X > {hi:g}%", top(d))):
        if len(g):
            aux.append(f"{name}：发生 {pp(g['hit'].mean())}（{len(g)} 次）；随机日期同类事件 {pp(base[g['key']].mean())}")
    always = d_all[(d_all["status"] == "任何价位都成立") & d_all["happen"]]
    if len(always):
        aux.append(f"求解器说\"任何价位都会发生\"的：实际发生 {pp(always['hit'].mean())}（{len(always)} 次）")
    by_k = ", ".join(f"K={k} {pp(g['hit'].mean())}（{len(g)}）" for k, g in top(d).groupby("K"))
    if by_k:
        aux.append(f"X > {hi:g}% 按 K 分：{by_k}")
    return {"id": "H4", "claim": "推演：说\"不可避免\"的事，真的发生了", "metric": f"X > {hi:g}% 档发生率 − X < {lo:g}% 档发生率（判定另要 X > {hi:g}% 档 ≥ {pp(c['min_rate'])}）",
            "unit": "pp", "sign": 1, "ests": ests, "rates": {k: est_json(v) for k, v in rates.items()},
            "verdict": ctx.verdict(1, ests, "H4", extra_ok=extra, sample_ok=r.n >= c["min_events"]), "aux": aux}


def episodes(recs: list[dict], close: np.ndarray, c: dict) -> list[dict]:
    """横盘区段（中间断开不超过 merge_gap 天的合并）和之后第一次突破：收盘离开箱体上沿 / 下沿 breakout_pct。
    第 t 天比的是第 t−1 天（区段结束后就是结束那天）已知的箱体，周线排列取突破前一天。"""
    flat = [k for k, r in enumerate(recs) if r["type"] == "横盘"]
    runs: list[list[int]] = []
    for k in flat:
        if runs and k - runs[-1][1] <= c["merge_gap"] + 1:
            runs[-1][1] = k
        else:
            runs.append([k, k])
    out = []
    for a, b in runs:
        box = (None, None)
        for t in range(a, min(b + c["max_wait"], len(recs) - 1) + 1):
            if t > a and box[0] is not None:
                i = recs[t]["i"]
                up, down = close[i] > box[0] * (1 + c["breakout_pct"]), close[i] < box[1] * (1 - c["breakout_pct"])
                if up or down:
                    w = recs[t - 1]
                    out.append({"date": recs[t]["d"], "start": recs[a]["d"], "up": bool(up),
                                "weekly": "多头" if w["w_ma"] == w["w_ema"] == "多头" else
                                ("空头" if w["w_ma"] == w["w_ema"] == "空头" else "混乱")})
                    break
            if t <= b and recs[t]["box_high"] is not None and recs[t]["box_low"] is not None:
                box = (recs[t]["box_high"], recs[t]["box_low"])
    return out


def h5(ctx: Ctx) -> dict:
    c = ctx.cfg["H5"]
    rows = []
    for t, rs in ctx.recs.items():
        close = ctx.sigs[t]["Close"].to_numpy()
        rows += [{"ticker": t, **e} for e in episodes(rs, close, c)]
    ep = pd.DataFrame(rows, columns=["ticker", "date", "start", "up", "weekly"])
    ep["week"] = pd.to_datetime(ep["date"]).dt.strftime("%G-%V")
    ests, counts = {}, {}
    for s in ctx.sc:
        d = in_scope(ep, s)
        bull, bear = d[d["weekly"] == "多头"], d[d["weekly"] == "空头"]
        ests[s.name] = es.diff_est(bull["up"].astype(float), ctx.blocks(bull["date"]),
                                   bear["up"].astype(float), ctx.blocks(bear["date"]), ctx.bc)
        counts[s.name] = (bull["week"].nunique(), bear["week"].nunique())
    nb, nr = counts[DEV]
    ok = nb >= c["min_episodes"] and nr >= c["min_episodes"]
    d = in_scope(ep, by_name(ctx.sc, DEV))
    aux = [f"开发集突破 {len(d)} 次：周线多头 {int((d['weekly'] == '多头').sum())} 次（{nb} 个独立周），"
           f"空头 {int((d['weekly'] == '空头').sum())} 次（{nr} 个独立周），混乱 {int((d['weekly'] == '混乱').sum())} 次",
           f"不看周线时向上突破的比例：{pp(d['up'].mean())}" if len(d) else "没有突破",
           *[f"周线{w}时向上突破 {pp(g['up'].mean())}（{len(g)} 次）" for w, g in d.groupby("weekly")]]
    return {"id": "H5", "claim": "横盘之后的突破方向跟周线走", "metric": "周线多头时向上突破的比例 − 周线空头时向上突破的比例",
            "unit": "pp", "sign": 1, "ests": ests, "counts": counts,
            "verdict": ctx.verdict(1, ests, "H5", extra_ok=ests[DEV].point >= c["min_diff"], sample_ok=ok), "aux": aux}


# ---------- H3：照方向持有 vs 同在场时间的随机持有 ----------

def h3_job(job: tuple) -> tuple[str, str, dict | None]:
    t, sc_name, up, sig_close, o, c, dates, first, lo, hi, cfg = job
    h = cfg["H3"]
    s = max(first, int(np.searchsorted(dates, lo)))
    e = min(len(dates) - 1, int(np.searchsorted(dates, hi, side="right")) - 1)
    if e - s < 60:
        return t, sc_name, None
    cost = cfg["sample"]["cost"]
    held = up[s:e]
    seed = h["seed"] + zlib.crc32(f"{t}|{sc_name}".encode())
    res = es.vs_random(o, c, held, s, cost, h["random_reps"], seed, h["mdd_pctl"])
    out = {"strategy": asdict(res)}
    for name, mask in [("买入持有", np.ones(e - s, dtype=bool))] + [
            (f"MA{int(n)}", (sig_close > pd.Series(sig_close).rolling(int(n)).mean().to_numpy())[s:e]) for n in h["naive_ma"]]:
        eq = es.equity(o, c, mask, s, cost)
        out[name] = {"mdd": es.max_drawdown(eq), "mar": es.mar(eq), "exposure": float(mask.mean())}
    return t, sc_name, out


def h3(ctx: Ctx, jobs: int) -> dict:
    h = ctx.cfg["H3"]
    work = []
    for t, rs in ctx.recs.items():
        names = [s for s in ctx.sc if t in s.tickers]
        if not names:
            continue
        n = len(ctx.rets[t])
        up = np.zeros(n, dtype=bool)
        for r in rs:
            up[r["i"]] = r["type"] in h["hold_types"]
        dates = np.array([str(d.date()) for d in ctx.rets[t].index])
        o, c = ctx.rets[t]["Open"].to_numpy(), ctx.rets[t]["Close"].to_numpy()
        for s in names:
            work.append((t, s.name, up, ctx.sigs[t]["Close"].to_numpy(), o, c, dates, rs[0]["i"], s.lo, s.hi, ctx.cfg))
    per: dict[str, dict[str, dict]] = defaultdict(dict)
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        for t, sc_name, out in ex.map(h3_job, work, chunksize=4):
            if out:
                per[sc_name][t] = out
    summ = {name: es.summarize_h3([es.HoldResult(**v["strategy"]) for v in per[name].values()]) for name in per}
    empty = es.summarize_h3([])
    get = lambda name: summ.get(name, empty)   # noqa: E731
    verdict = es.verdict_h3(get(DEV), [get(s.name) for s in halves_of(ctx.sc)], get("A"), get("B+C"),
                            get(HO) if ctx.holdout else None, h["ticker_share"], h["min_tickers"])
    dev = per.get(DEV, {})
    aux, simplify = [], []
    for n in h["naive_ma"]:
        k = f"MA{int(n)}"
        diffs = [v["strategy"]["mar"] - v[k]["mar"] for v in dev.values()
                 if math.isfinite(v["strategy"]["mar"]) and math.isfinite(v[k]["mar"])]
        med = float(np.median(diffs)) if diffs else float("nan")
        beat = sum(d > 0 for d in diffs)
        aux.append(f"和 {k} 朴素规则比：MAR 高的品种 {beat}/{len(diffs)}，MAR 差的中位数 {med:+.2f}")
        if not med > 0:
            simplify.append(k)
    if dev:
        col = lambda name, f: float(np.median([v[name][f] for v in dev.values() if math.isfinite(v[name][f])]))  # noqa: E731
        aux.append("开发集中位数（每只票一个账户）：" + "；".join(
            f"{name} 回撤 {pct(col(name, 'mdd'))}、MAR {col(name, 'mar'):.2f}、在场 {col(name, 'exposure'):.0%}"
            for name in ["strategy", "买入持有", *[f"MA{int(n)}" for n in h["naive_ma"]]]).replace("strategy", "照方向持有"))
        aux.append(f"随机持有（同在场时间）中位数：回撤 {pct(float(np.median([v['strategy']['rand_mdd_median'] for v in dev.values()])))}、"
                   f"MAR {float(np.nanmedian([v['strategy']['rand_mar_median'] for v in dev.values()])):.2f}")
    if simplify:
        aux.append(f"**附加判断：照方向持有的 MAR 打不过 {'、'.join(simplify)} 朴素规则，可以简化。**")
    return {"id": "H3", "claim": "躲开大跌：照方向持有，回撤比同在场时间的随机持有小，MAR 更高",
            "metric": f"回撤优于随机持有第 {h['mdd_pctl']:.0%} 分位、且 MAR 高于随机中位数的品种占比", "unit": "share",
            "summ": {k: asdict(v) | {"direction": v.direction} for k, v in summ.items()}, "per": per,
            "verdict": verdict, "aux": aux, "simplify": simplify}


# ---------- 报告 ----------

def pct(x: float | None) -> str:
    return "—" if x is None or not math.isfinite(x) else f"{x * 100:+.2f}%"


def pp(x: float | None) -> str:
    return "—" if x is None or not math.isfinite(x) else f"{x * 100:.0f}%"


def ci(e: es.Est, fmt=pct) -> str:
    return "区间 —" if e.lo is None else f"{fmt(e.lo)} ~ {fmt(e.hi)}"


def fmt_est(r: dict, e: es.Est | None, min_blocks: int) -> str:
    if e is None or e.n == 0:
        return "—"
    f = pct if r["unit"] == "pct" else (lambda x: "—" if not math.isfinite(x) else f"{x * 100:+.0f}pp")
    few = "，区块少" if e.blocks < min_blocks else ""
    return f"{f(e.point)}（{'—' if e.lo is None else f'{f(e.lo)} ~ {f(e.hi)}'}，{e.n}{few}）"


def fmt_h3(s: dict | None) -> str:
    if not s or not s["tickers"]:
        return "—"
    return f"{s['share_passed']:.0%}（分位中位 {s['median_pctl']:.0%}，MAR 差 {s['median_mar_edge']:+.2f}，{s['tickers']} 只）"


def cell(r: dict, name: str, min_blocks: int) -> str:
    return fmt_h3(r["summ"].get(name)) if r["id"] == "H3" else fmt_est(r, r["ests"].get(name), min_blocks)


RECOMMEND = [
    # (条件, 建议) —— 方案第 4 节
    (lambda v, s: v["H3"] == es.USEFUL and v["H1"] == v["H2"] == es.USELESS,
     "价值在避险，不在择时：结论卡片把\"现在别碰 / 可以拿着\"放在最前，进场细节降级。"),
    (lambda v, s: es.USEFUL in (v["H1"], v["H2"]), "模糊判断、类型可以当方向参考，保留在结论里。"),
    (lambda v, s: bool(s), "照方向持有打不过 MA60 / MA200 朴素规则：建议简化，核心换成更简单的规则，双均线的细节留作学习和解释。"),
    (lambda v, s: v["H4"] == es.USEFUL, "推演的\"不可避免\"提示可以加强。"),
    (lambda v, s: v["H4"] not in (es.USEFUL, es.DEV_PASSED), "推演的\"不可避免\"降级成辅助信息。"),
    (lambda v, s: v["H5"] not in (es.USEFUL, es.DEV_PASSED),
     "H5（横盘方向跟周线）没得到支持：rules.md 对应规则标\"回测不支持\"，不删，工作台不再据此给结论。"),
    (lambda v, s: v["H6"] not in (es.USEFUL, es.DEV_PASSED),
     "H6（假动作）没得到支持：rules.md 对应规则（J17、J18）标\"回测不支持\"，不删，工作台不再据此给结论。"),
    (lambda v, s: all(x in (es.USELESS, es.UNSURE, es.FEW) or x.startswith("只在") for x in v.values()),
     "全部无用或不确定：如实写进 README，工作台是学习和复盘工具，不提供可验证的交易优势。"),
]


def recommend(results: dict[str, dict]) -> list[str]:
    if set(results) != set(HYPS):
        return ["（只跑了部分主张，不套用第 4 节的对应表）"]
    v = {k: r["verdict"] for k, r in results.items()}
    return [text for cond, text in RECOMMEND if cond(v, results["H3"]["simplify"])] or ["没有落到第 4 节任何一行。"]


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(SKILL), *args], capture_output=True, text=True).stdout.strip()


def frozen_ok(cfg: dict) -> tuple[bool, str]:
    commit = cfg["freeze"]["commit"]
    files = [str(p.relative_to(SKILL)) for p in rule_files(cfg)]
    diff = git("diff", "--name-only", commit, "--", *files)
    untracked = git("ls-files", "--others", "--exclude-standard", "--", "scripts")
    bad = [f for f in diff.splitlines() + untracked.splitlines() if Path(f).name not in cfg["freeze"]["eval_files"]]
    return (not bad, "规则代码和冻结提交一致" if not bad else f"规则代码和冻结提交不一致：{', '.join(bad)}")


def last_verify(out: Path) -> str:
    path = out / "eval" / "verify.json"
    if not path.exists():
        return "还没跑过"
    v = json.loads(path.read_text())
    return f"{v['time']} {'全部通过' if v['ok'] else '**有不通过的**'}（{len(v['lines'])} 项，门槛哈希 {v['toml']}）"


def toml_hash() -> str:
    return hashlib.sha256(CONFIG.read_bytes()).hexdigest()[:12]


def threshold_log() -> list[str]:
    log = git("log", "--format=%h|%ad|%s", "--date=short", "--", str(CONFIG.relative_to(SKILL)))
    rows = [ln.split("|", 2) for ln in log.splitlines() if ln]
    return ["| 提交 | 日期 | 说明 |", "|---|---|---|", *[f"| {h} | {d} | {s} |" for h, d, s in rows]] if rows \
        else ["（evaluation.toml 还没有提交记录）"]


LIMITS = [
    "退市股取不到（WBA 已私有化退市，取不到行情），B、C 组按今天的市值挑，仍有幸存者偏差；A 组没有，A 组结论更可信。D 组用来量这个偏差。",
    "只有美国上市品种，只有日线；小时线 2021-12 以前没有，本轮不依赖小时线。六条主张的主指标都不用 P13，所以不用按\"需看图当满足 / 不满足\"分两种口径。",
    "视频作者的打法有很多看图的成分（顶底构造的位置、\"标志性动作\"），脚本只能近似。本轮测的是\"脚本化的这套方法\"，不等于作者本人的水平。",
    "2013 年以来大部分时间是牛市，熊市样本有限（2018Q4、2020、2022）。",
    "决定点每 5 天一个，之后 20 天的收益互相重叠；同一天几十只票一起动。区间用 60 个交易日一块的日期区块自助法，已经算进这两种相关，但区块之间仍不完全独立。",
    "复权：信号用拆股复权价，收益用含分红复权价（yfinance）。复权价会被之后的分红、拆股回溯调整。",
    "H3 只测了\"照方向持有\"（类型是稳定上涨或加速上涨就持有）。方案里另一版\"照打法持有\"要逐日跑完整分析（规则、推演），"
    "全量约多 1.5 小时，本轮没跑；上一轮回测（PR #20–#22）已经测过整套打法。",
]


def render(results: dict[str, dict], meta: dict, u: dict) -> str:
    out = [f"# 双均线方法评估：六条主张（{meta['mode']}）", ""]
    mb = meta["min_blocks"]
    if not meta["frozen"][0]:
        out += [f"> [!danger] **{meta['frozen'][1]}**。这份报告的数字不能当作冻结规则的评估结果。", ""]
    if meta["holdout_runs"] > 1:
        out += [f"> [!danger] **验证集已经跑了 {meta['holdout_runs']} 次**（只该跑一次）。", ""]
    out += [f"- 生成：{meta['generated']}；规则冻结在 `{meta['commit'][:12]}`（{meta['frozen'][1]}）；"
            f"门槛文件 `evaluation.toml` 哈希 `{meta['toml']}`；评估代码 `{meta['head'][:12]}`",
            f"- 行情：yfinance 日线 {meta['data_from']} ~ {meta['data_to']}；决定点 {meta['first']} ~ {meta['last']}；"
            f"品种按 {u['snapshot']} 的市值筛",
            f"- 校对（--verify）：{meta['verify']}",
            f"- 验证集：{'第 ' + str(meta['holdout_runs']) + ' 次运行' if meta['holdout_runs'] else '没跑'}",
            f"- 区间：90%，日期区块自助法（{meta['block_days']} 个交易日一块，重抽 {meta['reps']} 次）；"
            f"区块不到 {mb} 个的格子标\"区块少\"，区间不可靠",
            "- 读法：每格是点估计（90% 区间，样本数）。H3 一格是通过的品种占比（随机分位的中位数、MAR 差的中位数、品种数）。", ""]
    out += ["## 结论", "", "| 主张 | 结论 | 主指标 | 开发集 | 验证集 |", "|---|---|---|---|---|"]
    for r in results.values():
        out.append(f"| {r['id']} {r['claim']} | **{r['verdict']}** | {r['metric']} | {cell(r, DEV, mb)} | {cell(r, HO, mb)} |")
    out += ["", "## 分组、两半、市况", "",
            "| 主张 | " + " | ".join(meta["scopes"]) + " |", "|---|" + "---|" * len(meta["scopes"])]
    for r in results.values():
        out.append(f"| {r['id']} | " + " | ".join(cell(r, n, mb) for n in meta["scopes"]) + " |")
    out += ["", "A 组和 B+C 组方向一致才算数；D 组（曾经的巨头）只用来量幸存者偏差，不参与判定。市况切片只报告、不判定。", ""]
    out += ["## 对工作台意味着什么（方案第 4 节，建议）", "", *[f"- {x}" for x in recommend(results)], ""]
    for r in results.values():
        out += [f"## {r['id']} {r['claim']}", "", f"**{r['verdict']}**。主指标：{r['metric']}。", ""]
        if r["id"] != "H3" and r["ests"][DEV].excludes_zero(-r["sign"]):
            out += ["开发集的方向和主张**相反**，而且区间不跨 0。", ""]
        out += [f"- {x}" for x in r["aux"]] + [""]
    out += ["## 品种（快照 " + u["snapshot"] + "）", "", "| 组 | 开发集 | 验证集 |", "|---|---|---|"]
    for g in ("A", "B", "C", "D"):
        ts = u["groups"][g]
        out.append(f"| {g}（{len(ts)}） | {' '.join(t for t in ts if u['split'][t] == 'dev')} | "
                   f"{' '.join(t for t in ts if u['split'][t] == 'holdout')} |")
    out += ["", "不进评估：" + "；".join(f"{x['ticker']}（{x['reason']}）" for x in u["excluded"]) + "。", ""]
    if u["screen_dropped"]:
        out += ["筛选时去掉：" + "；".join(f"{x['ticker']}（{x['reason']}）" for x in u["screen_dropped"]) + "。", ""]
    out += ["## 门槛变更记录", "", *threshold_log(), "", "## 不能当真的地方", "", *[f"- {x}" for x in LIMITS], ""]
    return "\n".join(out)


def to_json(results: dict[str, dict], meta: dict, u: dict) -> dict:
    out = {"meta": meta, "universe": u, "hypotheses": {}}
    for k, r in results.items():
        x = {kk: vv for kk, vv in r.items() if kk != "ests"}
        if "ests" in r:
            x["ests"] = {n: est_json(e) for n, e in r["ests"].items()}
        x["primary"] = (r["summ"].get(DEV, {}).get("share_passed") if k == "H3"
                        else x["ests"][DEV]["point"])
        out["hypotheses"][k] = x
    return out


def compare(old_path: Path, new: dict) -> str:
    old = json.loads(old_path.read_text())
    lines = [f"## 和上一次比（{old_path.name}）", "", "| 主张 | 上次结论 | 这次结论 | 上次主指标 | 这次主指标 |", "|---|---|---|---:|---:|"]
    for k, r in new["hypotheses"].items():
        o = old["hypotheses"].get(k, {})
        f = lambda x: "—" if x is None or not math.isfinite(x) else f"{x:+.4f}"   # noqa: E731
        lines.append(f"| {k} | {o.get('verdict', '—')} | {r['verdict']} | {f(o.get('primary'))} | {f(r['primary'])} |")
    return "\n".join(lines) + "\n"


# ---------- 校对 ----------

def verify(cfg: dict, data: Path, out: Path, tickers: list[str], samples: int = 2) -> bool:
    """规则代码没改；抽查决定点的分析等于 dma_analyze.py --csv --asof；改掉之后的行情，结果不变。"""
    ok, msg = frozen_ok(cfg)
    lines = [("通过" if ok else "不通过") + f"：{msg}"]
    rng = np.random.default_rng(cfg["bootstrap"]["seed"])
    tmp = out / "eval" / "verify"
    tmp.mkdir(parents=True, exist_ok=True)
    for t in tickers:
        path = out / "eval" / "daily" / f"{t}.jsonl"
        if not path.exists():
            lines.append(f"跳过 {t}：还没有缓存")
            continue
        recs = [json.loads(r) for r in path.read_text().splitlines()[1:]]
        dec = [r for r in recs if "lean" in r]
        px, _ = load_prices(data / f"{t}.csv")
        for r in [dec[k] for k in rng.choice(len(dec), min(samples, len(dec)), replace=False)]:
            i = r["i"]
            cut = tmp / f"{t}-{r['d']}.csv"
            bt.history_at(px, i).to_csv(cut)
            proc = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(cut), "--asof", r["d"],
                                   "--json"], capture_output=True, text=True, check=True)
            a = json.loads(proc.stdout)["analysis"]
            cli = {**regime_fields(a["regime"], a["play"]["key"], a["weekly"]), "lean": a["lean"]["label"],
                   "rules": {x["id"]: x["status"] for x in a["rules"]}}
            mine = {k: r[k] for k in cli}
            later = px.copy()
            later.iloc[i + 1:] = later.iloc[i + 1:] * 3
            shifted = analyze_day(later, i, t, True)
            same_cli = mine == cli
            same_future = {k: shifted[k] for k in r if k != "solves"} == {k: r[k] for k in r if k != "solves"}
            same_solves = [s[:9] for s in shifted["solves"]] == [s[:9] for s in r["solves"]]
            good = same_cli and same_future and same_solves
            ok &= good
            lines.append(f"{'通过' if good else '不通过'}：{t} {r['d']} 缓存 = CLI（{same_cli}），"
                         f"之后行情 ×3 分析不变（{same_future and same_solves}）")
    stamp = {"time": datetime.now().isoformat(timespec="seconds"), "ok": ok, "lines": lines, "toml": toml_hash(),
             "commit": cfg["freeze"]["commit"]}
    (out / "eval" / "verify.json").write_text(json.dumps(stamp, ensure_ascii=False, indent=1) + "\n")
    print("\n".join(lines))
    return ok


# ---------- 主程序 ----------

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", help="只跑这几条，逗号分隔，如 H3 或 H1,H4")
    p.add_argument("--tickers", help="换成这些品种（逗号分隔），不算开发集也不算验证集")
    p.add_argument("--holdout", action="store_true", help="开发集 + 验证集，写最终报告（验证集只该跑一次）")
    p.add_argument("--verify", action="store_true", help="核对冻结、抽查等于 CLI、不偷看未来")
    p.add_argument("--compare", type=Path, help="和上一份报告的 json 比")
    p.add_argument("--config", type=Path, default=CONFIG)
    p.add_argument("--out", type=Path, default=PROJECT / "reports/replay")
    p.add_argument("--data", type=Path, help="行情缓存，默认 <out>/data/eval")
    p.add_argument("--jobs", type=int, default=14)
    p.add_argument("--rebuild-universe", action="store_true")
    p.add_argument("--refresh", action="store_true", help="重新取行情")
    a = p.parse_args()
    cfg = es.load_config(a.config)
    data = a.data or a.out / "data" / "eval"
    only = [h.strip().upper() for h in a.only.split(",")] if a.only else list(HYPS)
    if bad := set(only) - set(HYPS):
        p.error(f"不认识的主张：{sorted(bad)}")
    u = universe(cfg, a.out, data, a.rebuild_universe, a.refresh)
    custom = [t.strip().upper() for t in a.tickers.split(",")] if a.tickers else None
    if custom:
        for t in custom:
            if fetch(t, data, cfg, a.refresh) is None:
                sys.exit(f"{t}：取不到行情")
        tickers = custom
    else:
        tickers = [t for t, s in u["split"].items() if s == "dev" or a.holdout]
    if a.verify:
        pick = custom or sorted(tickers)[::max(1, len(tickers) // 4)][:4]
        sys.exit(0 if verify(cfg, data, a.out, pick) else 1)
    runs_path = a.out / "eval" / "holdout-runs.json"
    runs = json.loads(runs_path.read_text()) if runs_path.exists() else []
    if a.holdout:
        runs.append({"time": datetime.now().isoformat(timespec="seconds"), "toml": toml_hash(), "only": only})
        runs_path.write_text(json.dumps(runs, ensure_ascii=False, indent=1) + "\n")
        print(f"验证集只该跑一次，这是第 {len(runs)} 次，记在 {runs_path}", file=sys.stderr)
    t0 = time.time()
    recs = daily(sorted(tickers), data, a.out, cfg, a.jobs)
    t_analysis = time.time() - t0
    loaded = {t: load_prices(data / f"{t}.csv") for t in tickers}
    sigs, rets = {t: v[0] for t, v in loaded.items()}, {t: v[1] for t, v in loaded.items()}
    calendar = sorted({str(d.date()) for df in rets.values() for d in df.index})
    sc = scopes(u, cfg, tickers, a.holdout, bool(custom))
    ctx = Ctx(cfg, recs, rets, sigs, sc, calendar, a.holdout)
    fns = {"H1": h1, "H2": h2, "H4": h4, "H5": h5, "H6": h6}
    results = {h: (h3(ctx, a.jobs) if h == "H3" else fns[h](ctx)) for h in only}
    days = [r["d"] for rs in recs.values() for r in rs]
    mode = "自选品种" if custom else ("开发集 + 验证集" if a.holdout else "开发集")
    meta = {"mode": mode, "generated": datetime.now().isoformat(timespec="seconds"), "commit": cfg["freeze"]["commit"],
            "head": git("rev-parse", "HEAD"), "frozen": frozen_ok(cfg), "toml": toml_hash(),
            "data_from": min(str(df.index[0].date()) for df in rets.values()),
            "data_to": max(str(df.index[-1].date()) for df in rets.values()), "first": min(days), "last": max(days),
            "holdout_runs": len(runs) if a.holdout else 0, "block_days": cfg["bootstrap"]["block_days"],
            "min_blocks": cfg["bootstrap"]["min_blocks"], "verify": last_verify(a.out),
            "reps": cfg["bootstrap"]["reps"], "scopes": [s.name for s in sc if s.name != DEV and s.name != HO],
            "tickers": sorted(tickers), "seconds": {"analysis": round(t_analysis, 1), "total": round(time.time() - t0, 1)}}
    md = render(results, meta, u)
    js = to_json(results, meta, u)
    if a.compare:
        md += "\n" + compare(a.compare, js)
    suffix = {"自选品种": "-custom", "开发集": "-dev"}.get(mode, "")
    stem = f"{cfg['sample']['snapshot']}-evaluation{suffix}" + ("" if only == list(HYPS) else "-" + "-".join(only))
    (a.out / f"{stem}.md").write_text(md)
    (a.out / f"{stem}.json").write_text(json.dumps(js, ensure_ascii=False, indent=1, default=str) + "\n")
    print(md)
    print(f"报告：{a.out / stem}.md（分析 {t_analysis:.0f}s，共 {time.time() - t0:.0f}s）", file=sys.stderr)


if __name__ == "__main__":
    main()
