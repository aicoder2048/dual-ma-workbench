"""逐笔模拟（纯函数）：每天收盘后的决定 → 第二天开盘成交 → 每笔的盈亏、持有天数、最大回撤；资金曲线；基准。

- 决定只用当天收盘及之前的数据（backtest.py 每天一份分析，等于 dma_analyze.py --asof 那天的结果）。
- 进场、离场都在信号次日的开盘价成交，每边扣 COST。
- 只做多。哪些打法能进场、进场后按什么离场，写在 SETUPS，出处是 references/playbooks.md 的"空仓 / 持仓"两列。
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from enum import Enum
from typing import Callable

import pandas as pd

COST = 0.0005            # 每边 0.05%（佣金 + 滑点的粗略估计）


class Chart(str, Enum):
    """规则状态是"需看图"（脚本算不了，例如回放日期早于小时线的数据窗口）时怎么算。

    IGNORE_HOURLY 不管小时线：P14 只看 P10–P12，量出吃回撤④ 这一条过滤掉了什么。
    """
    MET = "需看图当满足"
    UNMET = "需看图当不满足"
    IGNORE_HOURLY = "不看小时线"


@dataclass(frozen=True)
class Day:
    """一个决定点：某只票某天收盘后，分析结果里回测要用的部分。"""
    date: str
    key: str                       # 打法键（rules.play_key）
    type: str | None               # 趋势类型；过渡时为 None
    stage: str | None              # 阶段：延伸 / 回撤中 / 反弹中 / 转折中；过渡时为 None
    status: dict[str, str]         # 规则编号 → 满足 / 不满足 / 需看图
    yielded: frozenset[str]        # 满足但让位给别的规则（rules.YIELDS_TO）
    close: float
    ema20: float
    dirs: dict[str, int]           # 方向（5 根）：+1 / 0 / −1，键是 MA60、EMA60、EMA20 等
    side20: str | None             # 20/60 最近一次完整站在哪边（双交叉之后才换边）


# 不是单条规则、而是计划里的止损 / 失效条件（app/src/plan.ts 的同名条目，读同一份分析结果）
DERIVED: dict[str, Callable[[Day], bool]] = {
    # 稳定上涨持仓的止损：60 线组拐头向下（MA60、EMA60 都向下）
    "60 线组拐头向下": lambda d: d.dirs["MA60"] < 0 and d.dirs["EMA60"] < 0,
    # 20/60 双死叉：同一对周期的 MA、EMA 都死叉（J16），20/60 换到空头一边
    "J16 双死叉": lambda d: d.side20 == "空头",
    # 空仓计划进场后的止损（plan.ts ENTRY_STOP）：收盘回到 EMA20 下方、EMA20 向下
    "EMA20 止损": lambda d: d.close < d.ema20 and d.dirs["EMA20"] < 0,
}


@dataclass(frozen=True)
class Setup:
    """一种打法下的进场：key 是当天的打法键，任一 entries 满足就进；进场后任一 exits 满足就走。

    blocked_by：这些规则满足时不进（横盘里埋伏的底线已经破了，plan.ts 叫"横盘破位"）。
    """
    key: str
    entries: tuple[str, ...]
    exits: tuple[str, ...]
    blocked_by: tuple[str, ...] = ()


SETUPS: tuple[Setup, ...] = (
    # 横盘：末期埋伏（P2），假跌破收回是第二个买点（P6）；底线是 20/60 交叉或不可避免（P3），假突破先出局（P5）
    Setup("横盘", ("P2", "P6"), ("P3", "P5"), blocked_by=("P3",)),
    # 稳定上涨：吃回撤四个条件齐了（P14）；持仓看 MA 拐没拐头，60 线组拐头向下才走（20/60 双死叉只是深回撤，J7）
    Setup("稳定上涨", ("P14",), ("60 线组拐头向下",)),
    # 多头结构回撤中：双线系统两次机会（P19、P20，让位时不算）；进场后 EMA20 止损，双死叉结构坏
    Setup("多头结构回撤中", ("P19", "P20"), ("EMA20 止损", "J16 双死叉")),
)
BY_KEY = {s.key: s for s in SETUPS}


def check(day: Day, cond: str, chart: Chart) -> tuple[bool, bool]:
    """条件今天成不成立，和是不是靠"需看图"按 chart 补出来的。"""
    if cond in DERIVED:
        return DERIVED[cond](day), False
    if cond == "P14" and chart == Chart.IGNORE_HOURLY:
        return all(check(day, c, chart)[0] for c in ("P10", "P11", "P12")), False
    s = day.status[cond]
    if s == "需看图":
        return chart == Chart.MET, True
    return s == "满足" and cond not in day.yielded, False


@dataclass(frozen=True)
class Signal:
    setup: str
    rule: str
    chart: bool                    # 进场是靠"需看图当满足"来的


def entry_signal(day: Day, chart: Chart) -> Signal | None:
    """空仓时今天收盘后要不要进。进场条件和离场条件同一天都成立时不进（进了第二天就得走）。"""
    s = BY_KEY.get(day.key)
    if s is None or any(check(day, b, chart)[0] for b in s.blocked_by):
        return None
    if any(check(day, x, chart)[0] for x in s.exits):
        return None
    for rule in s.entries:
        ok, by_chart = check(day, rule, chart)
        if ok:
            return Signal(s.key, rule, by_chart)
    return None


def exit_reason(setup: str, day: Day, chart: Chart) -> str | None:
    return next((x for x in BY_KEY[setup].exits if check(day, x, chart)[0]), None)


@dataclass(frozen=True)
class Trade:
    ticker: str
    setup: str
    rule: str                      # 进场规则
    chart: bool
    signal: str                    # 出信号那天（收盘后决定）
    entry: str                     # 成交日（次日开盘）
    entry_px: float
    exit: str
    exit_px: float
    reason: str                    # 离场规则；"未平仓" = 样本结束时还拿着，按最后收盘价算
    ret: float                     # 扣过两边成本
    bars: int                      # 持有几根：离场日 − 进场日
    mae: float                     # 持有期间收盘价相对进场价的最大跌幅（≤ 0）
    entry_i: int
    exit_i: int


EntryFn = Callable[[int], Signal | None]
ExitFn = Callable[[int, Signal], str | None]


def simulate(ticker: str, px: pd.DataFrame, start: int, entry: EntryFn, exit_: ExitFn) -> list[Trade]:
    """从第 start 根起每天收盘后决定，次日开盘成交。px 要有 Open、Close 两列。

    entry(i) / exit_(i, signal) 只能看第 i 根及之前；最后一根出的信号没有次日，不执行。
    """
    o, c = px["Open"].to_numpy(), px["Close"].to_numpy()
    dates = [str(d.date()) for d in px.index]
    last = len(px) - 1
    out: list[Trade] = []
    held: tuple[Signal, int, int] | None = None   # (信号, 信号日, 进场日)

    def close(sig: Signal, s: int, e: int, x: int, px_out: float, reason: str) -> None:
        mae = min(c[e:x + 1] if reason == "未平仓" else c[e:x]) / o[e] - 1
        ret = px_out * (1 - COST) / (o[e] * (1 + COST)) - 1
        out.append(Trade(ticker, sig.setup, sig.rule, sig.chart, dates[s], dates[e], float(o[e]), dates[x],
                         float(px_out), reason, float(ret), x - e, float(mae), e, x))

    for i in range(start, last):
        if held is None:
            sig = entry(i)
            if sig:
                held = (sig, i, i + 1)
        else:
            reason = exit_(i, held[0])
            if reason:
                close(held[0], held[1], held[2], i + 1, o[i + 1], reason)
                held = None
    if held:
        close(held[0], held[1], held[2], last, c[last], "未平仓")
    return out


def rule_trades(ticker: str, px: pd.DataFrame, days: list[Day], chart: Chart) -> list[Trade]:
    """按 SETUPS 交易。days[k] 对应 px 的第 start + k 根（日期必须对得上）。"""
    start = px.index.get_loc(pd.Timestamp(days[0].date))
    for k, d in enumerate(days):
        if str(px.index[start + k].date()) != d.date:
            raise ValueError(f"{ticker}：第 {k} 个决定点 {d.date} 和行情 {px.index[start + k].date()} 对不上")
    return simulate(ticker, px, start,
                    lambda i: entry_signal(days[i - start], chart),
                    lambda i, sig: exit_reason(sig.setup, days[i - start], chart))


def ma60_trades(ticker: str, px: pd.DataFrame, start: int) -> list[Trade]:
    """朴素基准：收盘在 MA60 上方就买，跌到下方就卖（都在次日开盘）。"""
    ma = px["Close"].rolling(60).mean()
    above = (px["Close"] > ma).to_numpy()
    return simulate(ticker, px, start,
                    lambda i: Signal("MA60", "收盘 > MA60", False) if above[i] else None,
                    lambda i, _: None if above[i] else "收盘 < MA60")


def buy_hold(ticker: str, px: pd.DataFrame, start: int) -> Trade:
    """买入持有：信号日 start，次日开盘买，拿到最后。"""
    return simulate(ticker, px, start, lambda i: Signal("买入持有", "—", False), lambda i, _: None)[0]


def curve(px: pd.DataFrame, trades: list[Trade], start: int) -> pd.Series:
    """资金曲线（从第 start 根收盘的 1 开始，逐日盯市）：空仓那天收益 0。每笔的逐日收益连乘等于它的 ret。"""
    o, c = px["Open"].to_numpy(), px["Close"].to_numpy()
    r = [0.0] * len(px)
    for t in trades:
        e, x = t.entry_i, t.exit_i
        r[e] = c[e] / (o[e] * (1 + COST)) - 1
        for k in range(e + 1, x):
            r[k] = c[k] / c[k - 1] - 1
        if t.reason == "未平仓":
            r[x] = (1 + r[x]) * (1 - COST) - 1 if x == e else c[x] * (1 - COST) / c[x - 1] - 1
        else:
            r[x] = o[x] * (1 - COST) / c[x - 1] - 1
    s = pd.Series(r[start + 1:], index=px.index[start + 1:])
    return (1 + s).cumprod()


def max_drawdown(eq: pd.Series) -> float:
    peak = eq.cummax().clip(lower=1.0)
    return float((eq / peak - 1).min()) if len(eq) else 0.0


def exposure(px: pd.DataFrame, trades: list[Trade], start: int) -> float:
    """在场时间占比：收盘时有仓位的天数 / 样本天数。"""
    held = sum(t.exit_i - t.entry_i + (1 if t.reason == "未平仓" else 0) for t in trades)
    return held / (len(px) - 1 - start)


def random_entry(px: pd.DataFrame, start: int, bars: int) -> float | None:
    """同一只票、同一段时间里，随便哪天开盘买、拿 bars 根后开盘卖的平均收益（扣同样成本）。"""
    o = px["Open"].to_numpy()
    ends = range(start + 1, len(px) - bars)
    if bars < 1 or not ends:
        return None
    return sum(o[i + bars] * (1 - COST) / (o[i] * (1 + COST)) - 1 for i in ends) / len(ends)


def bootstrap_ci(xs: list[float], n: int = 2000, seed: int = 7, level: float = 0.9) -> tuple[float, float] | None:
    """均值的自助法区间（固定种子，结果可复现）。样本之间不独立，区间只会偏窄。"""
    if len(xs) < 2:
        return None
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(xs, k=len(xs))) / len(xs) for _ in range(n))
    lo = means[int((1 - level) / 2 * n)]
    return lo, means[int((1 + level) / 2 * n) - 1]


def forward(px: pd.DataFrame, i: int, h: int) -> float | None:
    """第 i 天收盘后的信号，次日开盘买、h 根后开盘卖的收益（不扣成本）；数据不够为 None。"""
    o = px["Open"].to_numpy()
    return None if i + 1 + h >= len(px) else float(o[i + 1 + h] / o[i + 1] - 1)
