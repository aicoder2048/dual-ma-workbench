"""推演与求解：门槛路径、情景引擎、"K 天内让某事件发生（不发生）所需的持平价位"。

情景引擎不推公式：把假设的未来收盘价接在序列后面，重跑 add_indicators，
MA、EMA、排列、交叉都用同一套判断。第 k 天 = 推演的第 k 个交易日（k 从 1 起）。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum

import pandas as pd

from indicators import PERIODS, add_indicators, arrangement

HURDLE_DAYS = {20: 20, 60: 30, 120: 30}   # 每条 MA 看多少天的抵扣价
SCENARIO_DAYS = 30
SOLVE_DAYS = (10, 20, 30)                 # 30 天和 MA60、MA120 的门槛路径、持平情景同一个跨度
PAIRS = ((20, 60), (60, 120))
SEARCH_RANGE = (0.2, 5.0)                 # 求解时持平价位的搜索范围（现价的倍数）
SEARCH_TOL = 1e-7                         # 二分到现价的这个比例为止


@dataclass(frozen=True)
class HurdlePath:
    """MA(period) 未来 days 天每天要扣掉的收盘价。

    读法：收盘保持在 max_price 之上，这 days 天 MA 天天上行；在 min_price 之下，天天下行。
    """
    period: int
    days: int
    dates: list[str]      # 第 k 天扣掉的那根 K 线的日期
    prices: list[float]
    max_price: float
    max_day: int
    min_price: float
    min_day: int


@dataclass(frozen=True)
class LineTurn:
    line: str             # "MA60"、"EMA20"
    now: str              # 今天的方向：上 / 下 / 平
    turn_day: int | None  # 第几天转成反方向；None = 推演期内不转


@dataclass(frozen=True)
class PairCross:
    kind: str             # MA / EMA
    pair: str             # "20/60"
    now: str              # 快线今天在慢线的：上方 / 下方
    cross: str | None     # 金叉 / 死叉
    cross_day: int | None


@dataclass(frozen=True)
class Scenario:
    name: str
    level: float
    days: int
    turns: list[LineTurn]
    crosses: list[PairCross]
    end_arr_ma: str
    end_arr_ema: str
    end_values: dict[str, float]


class EventKind(str, Enum):
    """每一种都是"某一天的状态"；事件发生 = 推演期内至少有一天处于这个状态。"""
    TURN_UP = "拐头向上"          # line{fast} 当天比前一天高
    TURN_DOWN = "拐头向下"
    ABOVE = "站上"                # line{fast} > line{slow}
    BELOW = "跌破"
    DOUBLE_ABOVE = "双双站上"     # MA、EMA 两对都 fast > slow
    DOUBLE_BELOW = "双双跌破"
    ALIGN_UP = "理顺向上"         # 双双站上，且慢线组（MA、EMA）当天都向上
    ALIGN_DOWN = "理顺向下"


@dataclass(frozen=True)
class Event:
    kind: EventKind
    fast: int
    slow: int | None = None
    line: str = "MA"              # TURN_*、ABOVE、BELOW 用哪种线；双线事件不看它

    def describe(self) -> str:
        if self.kind in (EventKind.TURN_UP, EventKind.TURN_DOWN):
            return f"{self.line}{self.fast} {self.kind.value}"
        if self.kind in (EventKind.ABOVE, EventKind.BELOW):
            return f"{self.line}{self.fast} {self.kind.value} {self.line}{self.slow}"
        if self.kind in (EventKind.DOUBLE_ABOVE, EventKind.DOUBLE_BELOW):
            return f"{self.fast} 线组{self.kind.value} {self.slow} 线组"
        side, way = ("上方", "向上") if self.kind == EventKind.ALIGN_UP else ("下方", "向下")
        return f"{self.kind.value}（{self.fast} 线组在 {self.slow} 线组{side}，且 {self.slow} 线组{way}）"

    def state(self, ext: pd.DataFrame, days: int) -> pd.Series:
        """推演期每一天是否处于这个状态（ext = 接上假设收盘价后的完整序列）。"""
        fut = ext.iloc[-days:]
        up = self.kind in (EventKind.TURN_UP, EventKind.ABOVE, EventKind.DOUBLE_ABOVE, EventKind.ALIGN_UP)

        def gap(kind: str) -> pd.Series:
            g = fut[f"{kind}{self.fast}"] - fut[f"{kind}{self.slow}"]
            return g > 0 if up else g < 0

        def rising(col: str) -> pd.Series:
            d = ext[col].diff().iloc[-days:]
            return d > 0 if up else d < 0

        if self.kind in (EventKind.TURN_UP, EventKind.TURN_DOWN):
            return rising(f"{self.line}{self.fast}")
        if self.kind in (EventKind.ABOVE, EventKind.BELOW):
            return gap(self.line)
        both = gap("MA") & gap("EMA")
        if self.kind in (EventKind.DOUBLE_ABOVE, EventKind.DOUBLE_BELOW):
            return both
        return both & rising(f"MA{self.slow}") & rising(f"EMA{self.slow}")


class SolveStatus(str, Enum):
    LEVEL = "有临界价位"
    ALWAYS = "任何价位都成立"
    NEVER = "任何价位都不成立"


@dataclass(frozen=True)
class SolveResult:
    event: str
    happen: bool              # True = 求"让它发生"，False = 求"让它不发生"
    days: int
    status: SolveStatus
    level: float | None       # 临界持平价位（代回情景引擎，目标恰好成立）
    pct: float | None         # 相对现价 %
    side: str | None          # 持平在 level "以上" / "以下" 目标才成立


def hurdle_path(df: pd.DataFrame, n: int, days: int) -> HurdlePath:
    """第 k 天把 close[-n + k - 1] 扣出 MA(n) 的窗口（days ≤ n，扣的都是已知收盘价）。"""
    future = df["Close"].iloc[-n:][:days]
    prices = [float(v) for v in future]
    hi, lo = max(prices), min(prices)
    return HurdlePath(period=n, days=days, dates=[str(d.date()) for d in future.index], prices=prices,
                      max_price=hi, max_day=prices.index(hi) + 1, min_price=lo, min_day=prices.index(lo) + 1)


def future_dates(df: pd.DataFrame, days: int) -> pd.DatetimeIndex:
    """推演第 1…days 天对应的日期：之后的工作日（不扣节假日，所以只是约数）。"""
    return pd.bdate_range(df.index[-1] + pd.Timedelta(days=1), periods=days)


def extend(df: pd.DataFrame, closes: list[float]) -> pd.DataFrame:
    idx = future_dates(df, len(closes))
    return add_indicators(pd.concat([df[["Close"]], pd.DataFrame({"Close": closes}, index=idx)]))


def _direction(delta: float) -> str:
    return "上" if delta > 0 else ("下" if delta < 0 else "平")


def _first_day(flags: pd.Series) -> int | None:
    hits = [k for k, f in enumerate(flags, start=1) if f]
    return hits[0] if hits else None


def run_scenario(df: pd.DataFrame, level: float, days: int, name: str = "持平") -> Scenario:
    ext = extend(df, [level] * days)
    base = len(df) - 1                       # ext 里"今天"的位置
    turns = []
    for kind in ("MA", "EMA"):
        for n in PERIODS:
            col = ext[f"{kind}{n}"]
            delta = col.diff()
            now = _direction(delta.iloc[base])
            fut = delta.iloc[base + 1:]
            flips = {"上": fut < 0, "下": fut > 0, "平": fut != 0}[now]
            turns.append(LineTurn(line=f"{kind}{n}", now=now, turn_day=_first_day(flips)))
    crosses = []
    for kind in ("MA", "EMA"):
        for fast, slow in PAIRS:
            gap = ext[f"{kind}{fast}"] - ext[f"{kind}{slow}"]
            above = bool(gap.iloc[base] > 0)
            day = _first_day((gap.iloc[base + 1:] > 0) != above)
            crosses.append(PairCross(kind=kind, pair=f"{fast}/{slow}", now="上方" if above else "下方",
                                     cross=None if day is None else ("死叉" if above else "金叉"), cross_day=day))
    end = ext.iloc[-1]
    return Scenario(name=name, level=float(level), days=days, turns=turns, crosses=crosses,
                    end_arr_ma=arrangement(end, "MA"), end_arr_ema=arrangement(end, "EMA"),
                    end_values={f"{k}{n}": float(end[f"{k}{n}"]) for k in ("MA", "EMA") for n in PERIODS})


def occurs(df: pd.DataFrame, event: Event, level: float, days: int) -> bool:
    """收盘持平在 level，days 天内事件是否发生。"""
    return bool(event.state(extend(df, [level] * days), days).any())


def solve(df: pd.DataFrame, event: Event, days: int, happen: bool = True) -> SolveResult:
    """二分持平价位，找"days 天内让事件发生（happen=False 时：不发生）"的临界价位。

    所有事件对持平价位都是单调的（价位越高，快线、MA 越往上走），所以两端一比就知道方向。
    """
    close = float(df["Close"].iloc[-1])
    lo, hi = close * SEARCH_RANGE[0], close * SEARCH_RANGE[1]

    def goal(level: float) -> bool:
        return occurs(df, event, level, days) == happen

    at_lo, at_hi = goal(lo), goal(hi)
    common = dict(event=event.describe(), happen=happen, days=days)
    if at_lo == at_hi:
        status = SolveStatus.ALWAYS if at_lo else SolveStatus.NEVER
        return SolveResult(**common, status=status, level=None, pct=None, side=None)
    # 不变式：good 一侧成立，bad 一侧不成立
    good, bad = (hi, lo) if at_hi else (lo, hi)
    while abs(good - bad) > close * SEARCH_TOL:
        mid = (good + bad) / 2
        good, bad = (mid, bad) if goal(mid) else (good, mid)
    return SolveResult(**common, status=SolveStatus.LEVEL, level=good, pct=(good / close - 1) * 100,
                       side="以上" if at_hi else "以下")


def _default_targets(df: pd.DataFrame) -> list[tuple[Event, bool]]:
    """默认求解的目标：每条 MA 往反方向拐；每对线组走向反面；排列往没理顺的方向理顺。"""
    targets: list[tuple[Event, bool]] = []
    for n in PERIODS:
        rising = df[f"MA{n}"].iloc[-1] > df[f"MA{n}"].iloc[-2]
        targets.append((Event(EventKind.TURN_DOWN if rising else EventKind.TURN_UP, n), True))
    for fast, slow in PAIRS:
        above = bool(Event(EventKind.DOUBLE_ABOVE, fast, slow).state(df, 1).iloc[-1])
        # 已经双双在上：求"不出现双双跌破"；否则求"双双站上"
        targets.append((Event(EventKind.DOUBLE_BELOW, fast, slow), False) if above
                       else (Event(EventKind.DOUBLE_ABOVE, fast, slow), True))
    for kind in (EventKind.ALIGN_UP, EventKind.ALIGN_DOWN):
        event = Event(kind, 20, 60)
        if not event.state(df, 1).iloc[-1]:
            targets.append((event, True))
    return targets


def projection(df: pd.DataFrame) -> dict:
    """JSON 里的 projection 一块。"""
    close = float(df["Close"].iloc[-1])
    return {
        "dates": [str(d.date()) for d in future_dates(df, SCENARIO_DAYS)],
        "hurdles": [asdict(hurdle_path(df, n, HURDLE_DAYS[n])) for n in PERIODS],
        "scenarios": [asdict(run_scenario(df, close, SCENARIO_DAYS))],
        "solves": [asdict(solve(df, event, k, happen))
                   for event, happen in _default_targets(df) for k in SOLVE_DAYS],
    }
