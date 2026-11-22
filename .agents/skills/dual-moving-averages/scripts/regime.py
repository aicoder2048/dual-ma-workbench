"""趋势类型 × 阶段，和每对线组的五步进度。规则编号见 references/rules.md。

- 类型（J1–J6）看 60/120 线组：次序、方向是否一致（平行），加上 60 线的钟表方向。
- 阶段（J7）看 20 线组和价格：用 20/60 这一对的五步进度。
- 方向和斜率是两个量：方向是"拐没拐"（indicators 的逐日变化，五步进度用它），
  斜率是钟表方向（对数坐标、固定 CLOCK_WINDOW 根，类型用它）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

import pandas as pd

from structure import Structure

CLOCK_WINDOW = 20          # 钟表：固定看最近 20 根（视频 B 01:18 "所有的品种都使用相同的时间长度"）
CLOCK_SCALE = 0.111        # 校准值：20 根对数涨幅 0.111 画成 45°。GOOGL 2021-04-14 的 MA60 正好 2 点钟
FLAT_DEG = 15.0            # 2 点半 ~ 3 点半之间算走平（视频 B 00:47）
ACCEL_DEG = 60.0           # 1 点钟以上 / 5 点钟以下算加速（视频 B 00:36、00:59）
EXTREME_PCTL = 0.95        # 脚本自定：20 线乖离率在自身历史两端 5% 算大幅乖离
RANGE_SPREAD_PCT = 5.0     # 脚本自定：6 条线最大最小差 < 价格 5% 算靠拢
DENSE_PCT = 2.0            # 视频 B 04:21：最高最低均线相差 < 2% 算高度密集
RANGE_MIN_DAYS = 126       # 视频 B 03:48：不少于 6 个月，按 126 个交易日算
OPEN_LOOKBACK = 5          # 脚本自定：线间距比 5 根前大，算张嘴
ACCEL_START_LOOKBACK = 60  # 脚本自定：60 根内 60/120 线组还没按这个方向排好，算加速起点

UP, DOWN = 1, -1


class TrendType(str, Enum):
    ACCEL_UP = "加速上涨"
    STEADY_UP = "稳定上涨"
    RANGE = "横盘"
    STEADY_DOWN = "稳定下跌"
    ACCEL_DOWN = "加速下跌"


class Stage(str, Enum):
    EXTEND = "延伸"
    PULLBACK = "回撤中"     # 上涨里
    BOUNCE = "反弹中"       # 下跌里
    TURNING = "转折中"


class Transition(str, Enum):
    """60/120 线组定不出类型时，按 20/60 的结构命名。"""
    BULL_PULLBACK = "多头结构回撤中"
    BEAR_BOUNCE = "空头结构反弹中"
    TOPPING = "顶部转折中"
    BOTTOMING = "底部转折中"
    DISORDER = "失序"


class Step(str, Enum):
    BREAK = "破线"
    EMA_TURN = "EMA 拐头"
    MA_TURN = "MA 拐头"
    FIRST_CROSS = "第一个交叉"
    DOUBLE_CROSS = "双交叉"


@dataclass(frozen=True)
class Clock:
    line: str
    angle: float              # 度，+90 = 12 点钟，0 = 3 点钟，−90 = 6 点钟
    hour: str                 # "2 点钟"、"12 点半"


@dataclass(frozen=True)
class StepDate:
    step: Step
    date: str | None


@dataclass(frozen=True)
class Turn:
    direction: str            # 向下（多转空）/ 向上（空转多）
    steps: list[StepDate]     # 按五步的顺序，没发生的 date 为 None
    progress: int             # 已发生几步


@dataclass(frozen=True)
class PairProgress:
    pair: str                 # "20/60"
    side: str | None          # 最近一次完整站在哪边：多头 / 空头；None = 还没有过
    completed: Turn | None    # 走到这一边的那次转折（五步走完）
    current: Turn | None      # 正在往反方向走的转折；None = 还没有 side


@dataclass(frozen=True)
class RangeInfo:
    days: int                 # 60 线连续走平（2 点半 ~ 3 点半）了多少根
    spread_pct: float         # 6 条线最大最小差 / 价格
    dense: bool               # < DENSE_PCT
    box_high: float | None    # 横盘期间的波峰、波谷（阶段 1 的波段端点）
    box_low: float | None
    opening: str | None       # 张嘴：多头 / 空头 / None


@dataclass(frozen=True)
class Accel:
    phase: str                # 起点 / 末端
    by: str                   # 什么让它算加速：钟表 / 乖离


# J8 的起点 / 末端是加速出现在趋势哪一头（视频 B 08:59「通常出现在趋势 刚开始的阶段」、09:03「或者是趋势 即将结束的阶段」），
# 不是 J7 的阶段。给人读的文字一律写"出现在{ACCEL_WHERE[phase]}"，不写裸的"起点"，免得和"延伸"读成前后矛盾
ACCEL_WHERE = {"起点": "趋势刚开始", "末端": "趋势即将结束"}


@dataclass(frozen=True)
class Regime:
    type: TrendType | None
    stage: Stage | None
    transition: Transition | None
    name: str
    direction: int            # 类型线的方向：+1 / −1 / 0
    clock60: Clock
    clock20: Clock
    order: int                # 60/120 次序：两对都 60 > 120 为 +1，都 < 为 −1，否则 0
    dir60: int                # 60 线组钟表方向：MA60、EMA60 同号才算
    dir120: int
    depth: str | None         # 回撤 / 反弹到哪一组线
    range: RangeInfo | None
    accel: Accel | None
    crossed: bool = False     # 20/60 已交叉或到了另一边（J7）：稳定类型里是深回撤 / 深反弹，加速里是转折中
    why: str | None = None    # 过渡状态：为什么叫这个名字（照 classify 的条件）


def _angle(series: pd.Series) -> pd.Series:
    """每一根的钟表角度：最近 CLOCK_WINDOW 根的对数涨幅按 CLOCK_SCALE 换成度数。"""
    slope = (series / series.shift(CLOCK_WINDOW)).map(math.log) / CLOCK_SCALE
    return slope.map(lambda s: math.degrees(math.atan(s)) if pd.notna(s) else float("nan"))


def hour_of(angle: float) -> str:
    """角度换成钟点，取到半点。"""
    h = round((3 - angle / 30) * 2) / 2
    whole = int(h)
    name = 12 if whole == 0 else whole
    return f"{name} 点半" if h != whole else f"{name} 点钟"


def clock(df: pd.DataFrame, line: str) -> Clock:
    a = float(_angle(df[line]).iloc[-1])
    return Clock(line=line, angle=a, hour=hour_of(a))


def _sign(x: float) -> int:
    return UP if x > 0 else (DOWN if x < 0 else 0)


def _agree(a: float, b: float) -> int:
    """两个量同号才给方向。"""
    sa, sb = _sign(a), _sign(b)
    return sa if sa == sb else 0


def group_dir(df: pd.DataFrame, n: int) -> int:
    return _agree(float(_angle(df[f"MA{n}"]).iloc[-1]), float(_angle(df[f"EMA{n}"]).iloc[-1]))


def side(row: pd.Series, fast: int, slow: int) -> int:
    return _agree(row[f"MA{fast}"] - row[f"MA{slow}"], row[f"EMA{fast}"] - row[f"EMA{slow}"])


# ---------- 五步进度（J15） ----------

def pair_progress(df: pd.DataFrame, fast: int, slow: int) -> PairProgress:
    """从头扫一遍：

    - "完整站在一边"：两对都快线在慢线那一边，收盘在两条快线那一边，两条快线都朝那边走。
    - 站在一边之后，往反方向的五步各记第一次出现的日期；回到同一边的完整状态，这次转折作废、清零；
      到了另一边的完整状态，这次转折算走完（completed），开始记下一次。
    """
    mf, ef, ms, es = (df[f"{k}{n}"] for k, n in (("MA", fast), ("EMA", fast), ("MA", slow), ("EMA", slow)))
    close = df["Close"]
    dmf, def_ = mf.diff(), ef.diff()
    dates = [str(d.date()) for d in df.index]
    start = int(ms.notna().to_numpy().argmax()) + 1
    cur_side, episode, completed = 0, {}, None

    def turn(direction: int, got: dict) -> Turn:
        steps = [StepDate(s, got.get(s)) for s in Step]
        return Turn(direction="向上" if direction == UP else "向下", steps=steps,
                    progress=sum(s.date is not None for s in steps))

    for i in range(start, len(df)):
        if cur_side:
            d = -cur_side
            lo, hi = min(mf.iloc[i], ef.iloc[i]), max(mf.iloc[i], ef.iloc[i])
            cross_ma = _sign(mf.iloc[i] - ms.iloc[i]) == d
            cross_ema = _sign(ef.iloc[i] - es.iloc[i]) == d
            hits = {
                Step.BREAK: close.iloc[i] < lo if d == DOWN else close.iloc[i] > hi,
                Step.EMA_TURN: _sign(def_.iloc[i]) == d,
                Step.MA_TURN: _sign(dmf.iloc[i]) == d,
                Step.FIRST_CROSS: cross_ma or cross_ema,
                Step.DOUBLE_CROSS: cross_ma and cross_ema,
            }
            for step, hit in hits.items():
                if hit and step not in episode:
                    episode[step] = dates[i]
        full = 0
        for s in (UP, DOWN):
            beyond = close.iloc[i] > max(mf.iloc[i], ef.iloc[i]) if s == UP else close.iloc[i] < min(mf.iloc[i], ef.iloc[i])
            if (_sign(mf.iloc[i] - ms.iloc[i]) == s and _sign(ef.iloc[i] - es.iloc[i]) == s and beyond
                    and _sign(dmf.iloc[i]) == s and _sign(def_.iloc[i]) == s):
                full = s
        if full and full != cur_side:
            if cur_side:
                completed = turn(full, episode)
            cur_side = full
            episode = {}
        elif full:
            episode = {}
    name = {UP: "多头", DOWN: "空头"}
    return PairProgress(pair=f"{fast}/{slow}", side=name.get(cur_side), completed=completed,
                        current=turn(-cur_side, episode) if cur_side else None)


def _has(t: Turn | None, step: Step) -> bool:
    return t is not None and any(s.step == step and s.date for s in t.steps)


# ---------- 横盘（J5、J12–J14） ----------

def spread6(row: pd.Series) -> float:
    vals = [row[f"{k}{n}"] for k in ("MA", "EMA") for n in (20, 60, 120)]
    return float((max(vals) - min(vals)) / row["Close"] * 100)


def opening(df: pd.DataFrame) -> str | None:
    """张嘴：MA、EMA 都排成多头（空头），而且 20–60、60–120 两段间距都比 OPEN_LOOKBACK 根前大。"""
    now, then = df.iloc[-1], df.iloc[-1 - OPEN_LOOKBACK]
    for s, label in ((UP, "多头"), (DOWN, "空头")):
        ok = True
        for k in ("MA", "EMA"):
            g1, g2 = (now[f"{k}20"] - now[f"{k}60"]) * s, (now[f"{k}60"] - now[f"{k}120"]) * s
            p1, p2 = (then[f"{k}20"] - then[f"{k}60"]) * s, (then[f"{k}60"] - then[f"{k}120"]) * s
            ok &= g1 > 0 and g2 > 0 and g1 > p1 and g2 > p2
        if ok:
            return label
    return None


def range_info(df: pd.DataFrame, structure: Structure | None) -> RangeInfo:
    flat = _angle(df["MA60"]).abs() < FLAT_DEG
    days = 0
    for f in reversed(flat.tolist()):
        if not f:
            break
        days += 1
    hi = lo = None
    if structure is not None and days:
        since = str(df.index[-days].date())
        highs = [p.price for p in structure.pivots if p.kind == "高" and p.date >= since]
        lows = [p.price for p in structure.pivots if p.kind == "低" and p.date >= since]
        hi, lo = (max(highs) if highs else None), (min(lows) if lows else None)
    sp = spread6(df.iloc[-1])
    return RangeInfo(days=days, spread_pct=sp, dense=sp < DENSE_PCT, box_high=hi, box_low=lo, opening=opening(df))


# ---------- 类型 × 阶段 ----------

def _crossed(d: int, p20: PairProgress) -> bool:
    """20/60 已交叉，或 20 线组已经到了 60 线组另一边（J7）。"""
    on_side = {"多头": UP, "空头": DOWN}.get(p20.side or "", 0) == d
    return not on_side or _has(p20.current, Step.FIRST_CROSS)


def _stage(d: int, p20: PairProgress, steady: bool) -> Stage:
    """J7：20 线组还在类型那一边、没走出反向的一步是延伸；走了破线或拐头是回撤（反弹）。
    20/60 交叉了：稳定趋势里类型还由 60/120 定，仍是回撤（反弹）；加速里是转折。"""
    crossed = _crossed(d, p20)
    if crossed and not steady:
        return Stage.TURNING
    if crossed or (p20.current and p20.current.progress):
        return Stage.PULLBACK if d == UP else Stage.BOUNCE
    return Stage.EXTEND


def _depth(row: pd.Series, d: int) -> str | None:
    """回撤（反弹）从 20 线组往里穿到了哪一组：收盘在那组两条线的另一边才算，没穿过的那组就停。"""
    out = None
    for n, verb in ((20, "跌破" if d == UP else "站上"), (60, "跌破" if d == UP else "站上"),
                    (120, "击穿" if d == UP else "升破")):
        lines = (row[f"MA{n}"], row[f"EMA{n}"])
        if not ((row["Close"] < min(lines)) if d == UP else (row["Close"] > max(lines))):
            break
        out = f"{verb} {n} 线组"
    return out


def _stretched(d: int, bias_pctl: float) -> bool:
    return bias_pctl >= EXTREME_PCTL if d == UP else bias_pctl <= 1 - EXTREME_PCTL


def _accel(df: pd.DataFrame, d: int, angle60: float, bias_pctl: float) -> Accel | None:
    steep = angle60 * d >= ACCEL_DEG
    if not (steep or _stretched(d, bias_pctl)):
        return None
    recent = df.iloc[-ACCEL_START_LOOKBACK:]
    ordered = all(side(r, 60, 120) == d for _, r in recent.iterrows())
    return Accel(phase="末端" if ordered else "起点", by="钟表" if steep else "乖离")


def transition_why(t: Transition, order: int, dir60: int, dir120: int) -> str:
    """过渡状态为什么叫这个名字，照 classify 的条件写（J6，名字是脚本自定的）。"""
    above = {UP: "60 在 120 上方", DOWN: "60 在 120 下方"}
    way = {UP: "向上", DOWN: "向下"}
    if t in (Transition.BEAR_BOUNCE, Transition.BULL_PULLBACK):
        side, move = ("空头", "往上走：结构已经坏了，这是反弹") if order == UP else ("多头", "往下走：结构已经理顺，这是回撤")
        return f"{above[order]}，但 60 线组已经{way[-order]}；20/60 已是{side}、20 线组正{move}"
    if t in (Transition.TOPPING, Transition.BOTTOMING):
        if dir60 == -order:
            return f"{above[order]}，但 60 线组已经{way[-order]}：60 先转了向，20/60 不是反弹 / 回撤的样子"
        return f"{above[order]}、60 线组跟着{way[order]}，只差 120 线组拐过来：转折的最后一段"
    parts = []
    if not order:
        parts.append("MA、EMA 两对的 60/120 次序不一致（一对 60 在上，一对 120 在上）")
    if not dir60:
        parts.append("MA60、EMA60 方向不一致，60 线组说不清往哪走")
    return "；".join(parts) or "60/120 的次序和方向对不上"


def classify(df: pd.DataFrame, structure: Structure | None, bias_pctl: float) -> tuple[Regime, PairProgress]:
    row = df.iloc[-1]
    c60, c20 = clock(df, "MA60"), clock(df, "MA20")
    order, dir60, dir120 = side(row, 60, 120), group_dir(df, 60), group_dir(df, 120)
    p20 = pair_progress(df, 20, 60)
    common = dict(clock60=c60, clock20=c20, order=order, dir60=dir60, dir120=dir120)

    def typed(t: TrendType, d: int, accel: Accel | None = None, rng: RangeInfo | None = None) -> Regime:
        if t == TrendType.RANGE:
            return Regime(type=t, stage=None, transition=None, name=t.value, direction=0, depth=None,
                          range=rng, accel=None, **common)
        stage = _stage(d, p20, t in (TrendType.STEADY_UP, TrendType.STEADY_DOWN))
        label = stage.value
        if stage == Stage.TURNING:
            label = Transition.TOPPING.value if d == UP else Transition.BOTTOMING.value
        depth = _depth(row, d) if stage != Stage.EXTEND else None
        return Regime(type=t, stage=stage, transition=None, name=f"{t.value}·{label}", direction=d,
                      depth=depth, range=None, accel=accel, crossed=_crossed(d, p20), **common)

    # J1、J3、J4：60/120 线组次序和两组方向一致（120 不反向即可），按钟表和乖离分稳定、加速
    if order and dir60 == order and dir120 != -order:
        accel = _accel(df, order, c60.angle, bias_pctl)
        if accel:
            return typed(TrendType.ACCEL_UP if order == UP else TrendType.ACCEL_DOWN, order, accel), p20
        return typed(TrendType.STEADY_UP if order == UP else TrendType.STEADY_DOWN, order), p20
    # 加速起点：60/120 还没排好，乖离到了一端，且 20 线 1 点钟以上或 60 线组已经朝这边走
    d20 = _sign(c20.angle)
    if d20 and dir60 != -d20 and _stretched(d20, bias_pctl) and (abs(c20.angle) >= ACCEL_DEG or dir60 == d20):
        return typed(TrendType.ACCEL_UP if d20 == UP else TrendType.ACCEL_DOWN, d20,
                     Accel(phase="起点", by="乖离")), p20
    # J5：60 线走平、6 条线靠拢
    if abs(c60.angle) < FLAT_DEG and spread6(row) < RANGE_SPREAD_PCT:
        return typed(TrendType.RANGE, 0, rng=range_info(df, structure)), p20
    # J6 过渡：60/120 有次序，但 60 线组已经朝反方向走；或 60 跟着次序走、120 还在反向
    s20 = {"多头": UP, "空头": DOWN}.get(p20.side or "", 0)
    moving = p20.current is not None and p20.current.progress > 0
    if order and dir60 == -order:
        if s20 == -order and moving:
            t = Transition.BEAR_BOUNCE if order == UP else Transition.BULL_PULLBACK
        else:
            t = Transition.TOPPING if order == UP else Transition.BOTTOMING
    elif order and dir60 == order and dir120 == -order:
        t = Transition.BOTTOMING if order == UP else Transition.TOPPING   # 只差 120 拐过来：转折的最后一段
    else:
        t = Transition.DISORDER
    d = {Transition.BULL_PULLBACK: UP, Transition.BEAR_BOUNCE: DOWN}.get(t, 0)
    return Regime(type=None, stage=None, transition=t, name=t.value, direction=d, why=transition_why(t, order, dir60, dir120),
                  depth=_depth(row, d) if d else None, range=None, accel=None, **common), p20
