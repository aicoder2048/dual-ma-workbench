"""完整计划的逐笔模拟（纯函数）：计划 → 次日的单 → 成交 → 止损 / 目标 / 失效离场 → 一个账户的资金曲线和指标。

成交规则（信号出在当天收盘，单只在下一根有效，第二天按新计划重下）：
- 进场价高于信号日收盘（要突破才买，买入止损单）：开盘 ≥ 进场价按开盘成交（跳空），否则最高价 ≥ 进场价按进场价成交，否则不成交。
- 进场价等于收盘（"按收盘进"）：次日开盘成交。
- 进场价低于收盘（回落到才买，限价单）：开盘 ≤ 进场价按开盘成交，否则最低价 ≤ 进场价按进场价成交，否则不成交。
- 成交价不在止损上方（开盘就跌穿止损）：不进。
- 止损看最低价、目标看最高价：开盘已经越过就按开盘成交，否则按价位成交。同一根里止损和目标都碰到，算先止损（保守）。
  进场那一根只看止损：盘中成交之后先碰哪个不知道，保守地不算目标。
- 失效条件（打法的离场条件，收盘判断）成立：次日开盘离场。
- 每边 COST。股数按计划进场价算：可承受亏损 = 前一天收盘的账户净值 × risk_pct，股数 = 向下取整(可承受亏损 ÷ (进场 − 止损))。
  所有持仓的初始风险加起来不超过净值的 cap_pct，超了这笔不做；现金不够按现金能买的股数（不加杠杆）。
- 分红：持仓市值和离场所得乘以复权因子之比（含分红的总收益），和 evaluate.py 一样。
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

COST = 0.0005
TICK = 0.01


class Kind(str, Enum):
    STOP = "突破买入"      # 进场价在收盘上方
    OPEN = "开盘买入"      # 按收盘进：次日开盘
    LIMIT = "回落买入"     # 进场价在收盘下方


def entry_kind(entry: float, close: float) -> Kind:
    if math.isclose(entry, close, rel_tol=1e-12, abs_tol=0.0):
        return Kind.OPEN
    return Kind.STOP if entry > close else Kind.LIMIT


def fill_entry(kind: Kind, entry: float, o: float, h: float, lo: float) -> float | None:
    if kind == Kind.OPEN:
        return o
    if kind == Kind.STOP:
        return o if o >= entry else (entry if h >= entry else None)
    return o if o <= entry else (entry if lo <= entry else None)


def bar_exit(stop: float, target: float | None, o: float, h: float, lo: float, entry_bar: bool) -> tuple[float, str] | None:
    """这一根有没有碰到止损或目标：(成交价, 原因)。进场那一根只看止损（开盘已经在止损下方的单根本不会进）。"""
    if entry_bar:
        return (stop, "止损") if lo <= stop else None
    if o <= stop:
        return o, "止损"
    if target is not None and o >= target:
        return o, "目标"
    if lo <= stop:
        return stop, "止损"          # 和目标同在一根里也算先止损
    if target is not None and h >= target:
        return target, "目标"
    return None


@dataclass(frozen=True)
class Order:
    """信号日 signal 收盘后下给下一根的单。"""
    ticker: str
    signal: int                      # 全局日历上的位置
    kind: Kind
    entry: float                     # 计划进场价（股数按它算）
    stop: float
    target: float | None
    exits: tuple[str, ...]           # 失效条件（收盘成立就次日开盘走）
    max_bars: int | None = None      # 随机进场用：拿满这么多根就在开盘走
    key: str = ""
    rule: str = ""
    rr: float | None = None


@dataclass(frozen=True)
class Config:
    risk_pct: float = 1.0
    cap_pct: float = 6.0
    notional_pct: float | None = None   # 给了就不按风险算：每笔买净值的这么多（不设风险上限）
    cost: float = COST
    equity0: float = 1_000_000.0


@dataclass(frozen=True)
class Bars:
    """一只票在全局日历上的行情，没有数据的日子是 nan。o/h/l/c 是出信号用的拆股复权价，f 是含分红复权因子。"""
    o: np.ndarray
    h: np.ndarray
    lo: np.ndarray
    c: np.ndarray
    f: np.ndarray


@dataclass
class _Pos:
    order: Order
    e: int
    fill: float
    shares: int
    risk0: float
    k: float                          # 1 / 进场日复权因子
    pending: str | None = None        # 收盘时成立的失效条件：次日开盘走


@dataclass(frozen=True)
class Trade:
    ticker: str
    key: str
    rule: str
    kind: str
    signal: int
    entry_i: int
    exit_i: int
    plan_entry: float
    stop: float
    target: float | None
    rr: float | None
    fill: float
    exit_px: float
    shares: int
    reason: str                       # 止损 / 目标 / 失效：<条件> / 到期 / 未平仓
    pnl: float
    r: float                          # 盈亏 ÷ 初始风险（股数 × (成交价 − 止损)）
    notional: float                   # 进场金额 ÷ 前一天净值


@dataclass
class Result:
    trades: list[Trade]
    equity: np.ndarray                # 从 start 收盘的 equity0 起，每根收盘
    invested: np.ndarray              # 每根收盘持仓市值 ÷ 净值
    skipped: dict[str, int] = field(default_factory=dict)


def _shares(o: Order, eq: float, open_risk: float, cash: float, cfg: Config) -> tuple[int, str | None]:
    unit = o.entry - o.stop
    if cfg.notional_pct is not None:
        n = math.floor(eq * cfg.notional_pct / o.entry + 1e-9)
    else:
        n = math.floor(eq * cfg.risk_pct / 100 / unit + 1e-9)
        if open_risk + n * unit > eq * cfg.cap_pct / 100 + 1e-9:
            return 0, "超总风险上限"
    n = min(n, math.floor(cash / (o.entry * (1 + cfg.cost)) + 1e-9))
    return (n, None) if n > 0 else (0, "现金不够")


def simulate(cal_len: int, bars: dict[str, Bars], orders: dict[int, list[Order]], inval: dict[str, list[frozenset[str]]],
             start: int, cfg: Config = Config()) -> Result:
    """全局日历第 start 根收盘开始，到最后一根。orders[i]：第 i 根收盘后下的单；inval[票][i]：第 i 根收盘成立的失效条件。"""
    cash, eq_prev = cfg.equity0, cfg.equity0
    held: dict[str, _Pos] = {}
    trades: list[Trade] = []
    skipped: Counter[str] = Counter()
    equity, invested = [cfg.equity0], [0.0]
    last_c = {t: np.nan for t in bars}

    def close(t: str, p: _Pos, j: int, px: float, reason: str) -> None:
        nonlocal cash
        b = bars[t]
        proceeds = p.shares * px * b.f[j] * p.k * (1 - cfg.cost)
        cash += proceeds
        pnl = proceeds - p.shares * p.fill * (1 + cfg.cost)
        o = p.order
        trades.append(Trade(t, o.key, o.rule, o.kind.value, o.signal, p.e, j, o.entry, o.stop, o.target, o.rr, p.fill,
                            float(px), p.shares, reason, float(pnl), float(pnl / p.risk0),
                            p.shares * p.fill / equity[p.e - start - 1]))
        del held[t]

    for j in range(start + 1, cal_len):
        had = set(held)                   # 前一天收盘还拿着的票：下单时它在持仓里，不会给它下进场单
        for t in sorted(held):
            p, b = held[t], bars[t]
            if np.isnan(b.o[j]):
                continue
            if p.pending:
                close(t, p, j, b.o[j], f"失效：{p.pending}")
                continue
            if p.order.max_bars is not None and j - p.e >= p.order.max_bars:
                close(t, p, j, b.o[j], "到期")
                continue
            hit = bar_exit(p.order.stop, p.order.target, b.o[j], b.h[j], b.lo[j], False)
            if hit:
                close(t, p, j, *hit)
        open_risk = sum(p.shares * (p.order.entry - p.order.stop) for p in held.values())
        budget = cash
        for o in sorted(orders.get(j - 1, ()), key=lambda x: x.ticker):
            b = bars[o.ticker]
            if o.ticker in had or np.isnan(b.o[j]):
                continue
            n, why = _shares(o, eq_prev, open_risk, budget, cfg)
            if why:
                skipped[why] += 1
                continue
            fill = fill_entry(o.kind, o.entry, b.o[j], b.h[j], b.lo[j])
            if fill is None:
                skipped["没触发"] += 1
                continue
            if fill <= o.stop:
                skipped["开盘已破止损"] += 1
                continue
            n = min(n, math.floor(cash / (fill * (1 + cfg.cost)) + 1e-9))
            if n <= 0:
                skipped["现金不够"] += 1
                continue
            cash -= n * fill * (1 + cfg.cost)
            budget -= n * o.entry * (1 + cfg.cost)
            p = _Pos(o, j, float(fill), n, n * (fill - o.stop), 1 / b.f[j])
            held[o.ticker] = p
            open_risk += n * (o.entry - o.stop)
            hit = bar_exit(o.stop, o.target, b.o[j], b.h[j], b.lo[j], True)
            if hit:
                close(o.ticker, p, j, *hit)
        value = 0.0
        for t, b in bars.items():
            if not np.isnan(b.c[j]):
                last_c[t] = b.c[j] * b.f[j]
        for t, p in held.items():
            value += p.shares * last_c[t] * p.k
            if p.order.exits:
                now = [x for x in p.order.exits if x in inval[t][j]]
                p.pending = now[0] if now else None
        eq_prev = cash + value
        equity.append(eq_prev)
        invested.append(value / eq_prev if eq_prev > 0 else 0.0)
    for t in sorted(held):
        p = held[t]
        j = cal_len - 1
        while np.isnan(bars[t].c[j]):
            j -= 1
        close(t, p, j, bars[t].c[j], "未平仓")
    return Result(trades, np.asarray(equity), np.asarray(invested), dict(skipped))


# ---------- 指标 ----------

def cagr(eq: np.ndarray, days_per_year: int = 252) -> float:
    return float((eq[-1] / eq[0]) ** (days_per_year / (len(eq) - 1)) - 1) if len(eq) > 1 else 0.0


def max_drawdown(eq: np.ndarray) -> float:
    return float((eq / np.maximum.accumulate(eq) - 1).min()) if len(eq) else 0.0


def longest_losing_streak(trades: list[Trade]) -> int:
    """按离场顺序（同一天按票代码）连续亏损的最多笔数。"""
    best = run = 0
    for t in sorted(trades, key=lambda x: (x.exit_i, x.ticker)):
        run = run + 1 if t.pnl < 0 else 0
        best = max(best, run)
    return best


def payoff(rs: np.ndarray) -> float | None:
    """平均赢的 R ÷ 平均亏的 R 的绝对值。"""
    win, loss = rs[rs > 0], rs[rs <= 0]
    if not len(win) or not len(loss) or loss.mean() == 0:
        return None
    return float(win.mean() / -loss.mean())
