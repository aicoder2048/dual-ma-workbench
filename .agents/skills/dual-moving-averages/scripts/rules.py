"""规则层：每条规则一个编号，文字和来源在 references/rules.md，这里只放编号、种类、名字和计算。

evaluate 为 None 的规则脚本算不了，状态固定为"需看图"。公理永远成立，状态写"满足"，依据里写今天套用的结果。
吃回撤 / 反弹卖出（P10–P14）、构造、假突破这些成对的规则，按类型线的方向取多头一侧或空头镜像。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property
from enum import Enum
from typing import TYPE_CHECKING, Callable

import pandas as pd

from indicators import PERIODS, arrangement
from projection import HURDLE_DAYS, Event, EventKind, SolveStatus, hurdle_path, solve
from regime import DENSE_PCT, RANGE_MIN_DAYS, PairProgress, Regime, Stage, Step, Transition, TrendType, Turn
from structure import State, Structure
from volprofile import Mountain, Profile, plan_profile

if TYPE_CHECKING:
    from tradeplan import PlanSet, Target, TradePlan

VOLUME_SPIKE = 2.0       # 脚本自定：成交量 > 50 日均量 2 倍算大量
VOLUME_PERSIST = 3       # 脚本自定：近 20 日大量 ≥ 3 天算持续放量
FAKE_MOVE_PCT = 5.0      # 脚本自定：10 天内理顺要涨（跌）超过 5% 才行，算"距离很大"
FAKE_DAYS = 10
STOP_DAYS = 5            # 脚本自定：5 天内避免 20/60 双交叉要逆向走才行，算"不可避免"
BREAKOUT_BARS = 10       # 脚本自定：假突破的"迅速跌回"看突破后 10 根
FRESH_BARS = 5           # 脚本自定：双线系统的"首次"指最近 5 根内才拐上来
PATTERN_RECENT_BARS = 60  # 脚本自定：M 顶 / W 底、2B 只看最近 60 根里成形的
BIAS120_PCT = 50.0       # 视频 G 16:24：收盘偏离 EMA120 50% 以上
WEEKLY_BIAS120_PCT = 70.0  # 视频 G 24:31：周线偏离 120 线超过 70%


class Kind(str, Enum):
    AXIOM = "公理"
    VERDICT = "判定"
    ACTION = "动作"


class Status(str, Enum):
    MET = "满足"
    UNMET = "不满足"
    CHART = "需看图"


@dataclass(frozen=True)
class Result:
    status: Status
    basis: str
    levels: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Ctx:
    df: pd.DataFrame
    regime: Regime
    p20: PairProgress
    p60: PairProgress
    structure: Structure | None
    weekly: dict
    hourly: dict | None = None
    plan: PlanSet | None = None   # tradeplan.build 的结果：A6、P22–P25 读它

    @property
    def close(self) -> float:
        return float(self.df["Close"].iloc[-1])

    @property
    def row(self) -> pd.Series:
        return self.df.iloc[-1]

    @cached_property
    def profile(self) -> Profile | None:
        """最近 1 年的筹码分布（volprofile.plan_profile）：J45–J49、P38、P39 和找目标位读它。"""
        return plan_profile(self.df)


@dataclass(frozen=True)
class Rule:
    id: str
    kind: Kind
    name: str
    evaluate: Callable[[Ctx], Result] | None


def _met(ok: bool, basis: str, levels: dict[str, float] | None = None) -> Result:
    return Result(Status.MET if ok else Status.UNMET, basis, levels or {})


def _f(x: float) -> str:
    return f"{x:.2f}"


def _pct(x: float, close: float) -> str:
    return f"{(x / close - 1) * 100:+.1f}%"


def _dir(delta: float) -> str:
    return "上行" if delta > 0 else ("下行" if delta < 0 else "走平")


def _has(t: Turn | None, step: Step) -> bool:
    return t is not None and any(s.step == step and s.date for s in t.steps)


def _side(p: PairProgress) -> int:
    return {"多头": 1, "空头": -1}.get(p.side or "", 0)


# ---------- 公理 ----------

def a1_ma_hurdle(c: Ctx) -> Result:
    parts, levels = [], {}
    for n in PERIODS:
        drop = float(c.df["Close"].iloc[-n])
        levels[f"MA{n} 明天抵扣价"] = drop
        parts.append(f"MA{n} 明天抵扣价 {_f(drop)}，收盘不变则{_dir(c.close - drop)}")
    return Result(Status.MET, "；".join(parts), levels)


def a2_hurdle_path(c: Ctx) -> Result:
    parts, levels = [], {}
    for n in PERIODS:
        h = hurdle_path(c.df, n, HURDLE_DAYS[n])
        levels[f"MA{n} {h.days} 天抵扣价最高"] = h.max_price
        levels[f"MA{n} {h.days} 天抵扣价最低"] = h.min_price
        parts.append(f"MA{n}：{h.days} 天内收盘守在 {_f(h.max_price)}（{_pct(h.max_price, c.close)}）之上天天上行，"
                     f"在 {_f(h.min_price)}（{_pct(h.min_price, c.close)}）之下天天下行")
    return Result(Status.MET, "；".join(parts), levels)


def a3_ema_line(c: Ctx) -> Result:
    parts = [f"EMA{n} {_f(c.row[f'EMA{n}'])}，收盘在{'上' if c.close > c.row[f'EMA{n}'] else '下'}方，"
             f"明天{_dir(c.close - c.row[f'EMA{n}'])}" for n in PERIODS]
    return Result(Status.MET, "；".join(parts), {f"EMA{n}": float(c.row[f"EMA{n}"]) for n in PERIODS})


def a4_ema_first(c: Ctx) -> Result:
    d = c.df.diff().iloc[-1]
    parts = [f"{n}：EMA {_dir(d[f'EMA{n}'])}、MA {_dir(d[f'MA{n}'])}" for n in PERIODS]
    return Result(Status.MET, "；".join(parts))


# ---------- 判定：类型 × 阶段 ----------

def j1_type_from_60_120(c: Ctx) -> Result:
    r = c.regime
    sign = {1: "60 在 120 上", -1: "60 在 120 下", 0: "MA、EMA 不一致"}
    way = {1: "向上", -1: "向下", 0: "不一致"}
    basis = (f"60/120 次序：{sign[r.order]}；60 线组{way[r.dir60]}、120 线组{way[r.dir120]} → "
             f"{r.type.value if r.type else '定不出类型（看 J6）'}")
    return _met(r.type is not None, basis)


def j2_clock(c: Ctx) -> Result:
    r = c.regime
    return Result(Status.MET, f"MA60 {r.clock60.angle:+.0f}°（{r.clock60.hour}），MA20 {r.clock20.angle:+.0f}°（{r.clock20.hour}）")


def j3_accel(c: Ctx) -> Result:
    r = c.regime
    ok = r.type in (TrendType.ACCEL_UP, TrendType.ACCEL_DOWN)
    basis = f"{r.type.value}，{r.accel.phase}（按{r.accel.by}）" if ok else f"不是加速（{r.name}）"
    if ok:
        j37 = j37_extreme_bias(c)
        basis += f"；旁证 J37 {j37.status.value}：{j37.basis}"
    return _met(ok, basis)


def j4_steady(c: Ctx) -> Result:
    r = c.regime
    ok = r.type in (TrendType.STEADY_UP, TrendType.STEADY_DOWN)
    return _met(ok, f"{r.name}，60 线 {r.clock60.hour}")


def j5_range(c: Ctx) -> Result:
    r = c.regime
    if r.type != TrendType.RANGE:
        return _met(False, f"不是横盘（{r.name}，60 线 {r.clock60.hour}）")
    g = r.range
    box = f"，箱体 {_f(g.box_low)} ~ {_f(g.box_high)}" if g.box_low and g.box_high else ""
    levels = {k: v for k, v in (("箱体上沿", g.box_high), ("箱体下沿", g.box_low)) if v}
    return _met(True, f"60 线走平 {g.days} 根，6 条线相差 {g.spread_pct:.1f}%{box}", levels)


def j6_transition(c: Ctx) -> Result:
    r = c.regime
    return _met(r.transition is not None, r.name)


def j7_stage(c: Ctx) -> Result:
    r = c.regime
    if r.stage is None:
        return _met(False, f"{r.name}：没有阶段")
    return _met(True, f"{r.stage.value}" + (f"（{r.depth}）" if r.depth else ""))


def j8_accel_where(c: Ctx) -> Result:
    a = c.regime.accel
    return _met(a is not None, f"加速{a.phase}" if a else "不是加速")


def j9_regress(c: Ctx) -> Result:
    a = c.regime.accel
    bias = float(c.row["BIAS20"])
    return _met(a is not None, f"离 MA20 {bias:+.1f}%" + ("，有回归需求" if a else ""), {"MA20": float(c.row["MA20"])})


def _spikes(df: pd.DataFrame) -> int:
    if "Volume" not in df.columns or not df["Volume"].notna().any():
        return 0
    ratio = (df["Volume"] / df["Volume"].rolling(50).mean()).iloc[-20:]
    return int((ratio > VOLUME_SPIKE).sum())


def j10_volume_turn(c: Ctx) -> Result:
    n = _spikes(c.df)
    return _met(c.regime.accel is not None and n >= VOLUME_PERSIST, f"近 20 日大量 {n} 天" + ("" if c.regime.accel else "，不是加速"))


def j11_weekly_direction(c: Ctx) -> Result:
    w = c.weekly
    if not w.get("available"):
        return Result(Status.CHART, f"周线不可用：{w.get('reason')}")
    arr = f"周线 MA {w['arr_ma']}、EMA {w['arr_ema']}"
    if c.regime.type != TrendType.RANGE:
        return _met(False, f"不是横盘；{arr}")
    return _met(w["arr_ma"] == w["arr_ema"] and w["arr_ma"] != "混乱", arr)


def j12_range_long_enough(c: Ctx) -> Result:
    g = c.regime.range
    if g is None:
        return _met(False, "不是横盘")
    return _met(g.days >= RANGE_MIN_DAYS, f"已横 {g.days} 根，约 {g.days / 21:.1f} 个月")


def j13_range_dense(c: Ctx) -> Result:
    g = c.regime.range
    if g is None:
        return _met(False, "不是横盘")
    return _met(g.dense, f"6 条线相差 {g.spread_pct:.1f}%（< {DENSE_PCT:g}% 算高度密集）")


def j14_range_opening(c: Ctx) -> Result:
    g = c.regime.range
    if g is None:
        return _met(False, "不是横盘")
    return _met(g.opening == "多头", f"张嘴：{g.opening or '没有'}")


# ---------- 判定：转折 ----------

def _turn_text(p: PairProgress) -> str:
    if p.current is None:
        return f"{p.pair}：还没站稳过一边"
    done = [f"{s.step.value} {s.date}" for s in p.current.steps if s.date]
    return f"{p.pair} {p.side}，{p.current.direction}转折已走 {p.current.progress} 步" + (f"（{'，'.join(done)}）" if done else "")


def j15_three_steps(c: Ctx) -> Result:
    return _met(bool(c.p20.current and c.p20.current.progress), f"{_turn_text(c.p20)}；{_turn_text(c.p60)}")


def j16_double_cross(c: Ctx) -> Result:
    parts = []
    for fast, slow in ((20, 60), (60, 120)):
        ma, ema = c.row[f"MA{fast}"] > c.row[f"MA{slow}"], c.row[f"EMA{fast}"] > c.row[f"EMA{slow}"]
        parts.append(f"{fast}/{slow} MA、EMA 都在{'上' if ma else '下'}方" if ma == ema
                     else f"{fast}/{slow} MA 在{'上' if ma else '下'}、EMA 在{'上' if ema else '下'}，只有一组交叉")
    same = (c.row["MA20"] > c.row["MA60"]) == (c.row["EMA20"] > c.row["EMA60"])
    return _met(same, "；".join(parts))


def _align_level(c: Ctx, up: bool, days: int) -> tuple[str, dict[str, float]]:
    res = solve(c.df, Event(EventKind.ALIGN_UP if up else EventKind.ALIGN_DOWN, 20, 60), days)
    if res.status != SolveStatus.LEVEL:
        return f"{days} 天内{res.status.value}", {}
    return (f"{days} 天内要持平在 {_f(res.level)}（{res.pct:+.1f}%）{res.side}", {f"{days} 天内理顺": res.level})


def j17_fake_move(c: Ctx) -> Result:
    side = _side(c.p20)
    rebounding = side != 0 and c.p20.current is not None and c.p20.current.progress > 0
    if not rebounding:
        return _met(False, "20/60 没有逆着结构的反弹（回调）")
    up = side < 0
    res = solve(c.df, Event(EventKind.ALIGN_UP if up else EventKind.ALIGN_DOWN, 20, 60), FAKE_DAYS)
    if res.status == SolveStatus.ALWAYS:
        return _met(False, f"{FAKE_DAYS} 天内必然理顺")
    far = res.status == SolveStatus.NEVER or abs(res.pct) > FAKE_MOVE_PCT
    text, levels = _align_level(c, up, FAKE_DAYS)
    return _met(far, f"理顺（带方向）{text}", levels)


def j18_bad_order(c: Ctx) -> Result:
    under = c.row["MA20"] < c.row["MA60"] and c.row["EMA20"] < c.row["EMA60"]
    if not under:
        return _met(False, "20 线组不在 60 线组下方")
    up = c.close > max(c.row["MA20"], c.row["EMA20"])
    return _met(up, "20 线组在 60 线组下方，" + ("价格反弹到 20 线组上方" if up else "价格还在 20 线组下方"))


def j19_key_swing(c: Ctx) -> Result:
    d = c.df[["MA20", "EMA20"]].diff().iloc[-2:]
    flipped = [col for col in ("EMA20", "MA20") if (d[col].iloc[-1] > 0) != (d[col].iloc[-2] > 0)]
    levels = {"EMA20": float(c.row["EMA20"]), "MA20 明天抵扣价": float(c.df["Close"].iloc[-20])}
    return _met(bool(flipped), ("今天" + "、".join(flipped) + " 换了方向") if flipped else "今天 20 线组没换方向", levels)


# ---------- 判定：构造（视频 D） ----------

def _construct(c: Ctx, top: bool) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    k = c.structure.top if top else c.structure.bottom
    if k is None:
        return _met(False, "还没有")
    levels = {"作废价": k.invalidation}
    if k.complete_at is not None:
        levels["完成价"] = k.complete_at
    if k.next_at is not None:
        levels["下一步价"] = k.next_at
        levels["还差几根"] = k.bars_left
    basis = f"{k.state.value}，{'新高' if top else '新低'} {k.pivot_date} {_f(k.pivot_price)}"
    return _met(k.state == State.DONE, basis, levels)


def j20_top_construct(c: Ctx) -> Result:
    return _construct(c, True)


def j21_bottom_construct(c: Ctx) -> Result:
    return _construct(c, False)


def j22_construct_broken(c: Ctx) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    broken = [k for k in (c.structure.top, c.structure.bottom) if k and k.state == State.BROKEN]
    return _met(bool(broken), "；".join(f"{k.side.value}在 {k.broken_date} 作废" for k in broken) or "最近的构造没被破坏")


def j23_no_construct_no_top(c: Ctx) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    k = c.structure.top
    done = k is not None and k.state == State.DONE
    return _met(not done, "顶部构造已完成，可能（不一定）见顶" if done else "顶部构造没完成，不可能是顶")


def j24_swing(c: Ctx) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    s = c.structure
    levels = {k: p.price for k, p in (("最近波峰", s.last_high), ("最近波谷", s.last_low)) if p}
    basis = "，".join(f"{k} {_f(v)}" for k, v in levels.items()) or "还没有完整波段"
    return _met(bool(levels), basis, levels)


def _pattern(c: Ctx, names: tuple[str, ...]) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    since = str(c.df.index[-PATTERN_RECENT_BARS].date())
    found = [p for p in c.structure.patterns if p.name in names and p.dates[-1] >= since]
    if not found:
        return _met(False, f"最近 {PATTERN_RECENT_BARS} 根里没有")
    p = found[-1]
    return _met(p.state == "已形成", f"{p.name}{p.state}（{'、'.join(p.dates)}）", {"颈线或前高": p.level})


def j25_m_w(c: Ctx) -> Result:
    return _pattern(c, ("M 顶", "W 底"))


def j26_2b(c: Ctx) -> Result:
    return _pattern(c, ("2B 顶", "2B 底"))


def j27_complete_at(c: Ctx) -> Result:
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    parts, levels = [], {}
    for k, top in ((c.structure.top, True), (c.structure.bottom, False)):
        if k and k.state == State.FORMING and k.complete_at is not None:
            word = "最低价低于" if top else "最高价高于"
            parts.append(f"下一根{word} {_f(k.complete_at)} 就完成{k.side.value}")
            levels[f"{k.side.value}完成价"] = k.complete_at
    return _met(bool(parts), "；".join(parts) or "没有只差一根的构造", levels)


def j29_arrangement(c: Ctx) -> Result:
    ma, ema = arrangement(c.row, "MA"), arrangement(c.row, "EMA")
    return _met(ma == ema and ma != "混乱", f"MA {ma}、EMA {ema}")


def weekly_bias120(w: dict) -> float | None:
    """周收盘对周线 EMA120 的偏离（%）。视频说"120 的成本均线"，没说 MA 还是 EMA，和日线那一档一样用 EMA120（解读）。"""
    if not w.get("available"):
        return None
    line = next(x for x in w["lines"] if x["period"] == 120)
    return (w["close"] / line["ema"] - 1) * 100


def j37_extreme_bias(c: Ctx) -> Result:
    """J37：收盘偏离 EMA120 ≥ 50%，或周线偏离 120 线 ≥ 70%。只当加速的旁证（J3 依据里写出），不改类型判断。"""
    ema = float(c.row["EMA120"])
    d = (c.close / ema - 1) * 100
    w = weekly_bias120(c.weekly)
    week = f"周线离 EMA120 {w:+.1f}%（周线那一档 ≥ {WEEKLY_BIAS120_PCT:g}%）" if w is not None else "周线不可用"
    ok = abs(d) >= BIAS120_PCT or (w is not None and abs(w) >= WEEKLY_BIAS120_PCT)
    return _met(ok, f"收盘离 EMA120 {d:+.1f}%（偏离 ≥ {BIAS120_PCT:g}% 算大幅乖离）；{week}", {"EMA120": ema})


# ---------- 动作 ----------

def p1_range_wait(c: Ctx) -> Result:
    if c.regime.type != TrendType.RANGE:
        return _met(False, "不是横盘")
    return _met(p2_ambush(c).status != Status.MET, "末期三条件没齐，横盘中段不做")


def p2_ambush(c: Ctx) -> Result:
    g = c.regime.range
    if g is None:
        return _met(False, "不是横盘")
    conds = [j12_range_long_enough(c), j13_range_dense(c), j14_range_opening(c)]
    below = g.box_high is None or c.close <= g.box_high
    ok = all(r.status == Status.MET for r in conds) and below
    basis = "；".join(f"{i} {r.status.value}" for i, r in zip(("①时间", "②密集", "③张嘴"), conds))
    return _met(ok, basis + ("；还没突破" if below else "；已经突破箱体"), {"箱体上沿": g.box_high} if g.box_high else {})


def p3_ambush_stop(c: Ctx) -> Result:
    if _side(c.p20) <= 0:
        return _met(True, "20/60 已经不在多头一边")
    if _has(c.p20.current, Step.FIRST_CROSS):
        return _met(True, "20/60 已经出现第一个交叉")
    res = solve(c.df, Event(EventKind.DOUBLE_BELOW, 20, 60), STOP_DAYS, happen=False)
    if res.status != SolveStatus.LEVEL:
        return _met(res.status == SolveStatus.NEVER, f"{STOP_DAYS} 天内避免双死叉：{res.status.value}")
    need_rise = res.level > c.close
    return _met(need_rise, f"{STOP_DAYS} 天内避免 20/60 双死叉要持平在 {_f(res.level)}（{res.pct:+.1f}%）以上",
                {"避免双死叉": res.level})


def p5_fake_breakout(c: Ctx) -> Result:
    return _fake(c, top=True)


def p6_fake_breakdown(c: Ctx) -> Result:
    return _fake(c, top=False)


def _fake(c: Ctx, top: bool) -> Result:
    """① 最近 BREAKOUT_BARS 根里收盘越过最近波峰（波谷）又收回；② 之后收盘在 20 线组另一边、EMA20 朝那边拐。"""
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价")
    pivot = c.structure.last_high if top else c.structure.last_low
    if pivot is None:
        return _met(False, "还没有波峰（波谷）")
    close = c.df["Close"].iloc[-BREAKOUT_BARS:]
    s = 1 if top else -1
    out = [i for i, v in enumerate(close) if (v - pivot.price) * s > 0]
    back = [i for i in range(out[0] + 1, len(close)) if (close.iloc[i] - pivot.price) * s < 0] if out else []
    first = bool(back)
    lo, hi = min(c.row["MA20"], c.row["EMA20"]), max(c.row["MA20"], c.row["EMA20"])
    ema_turn = (c.df["EMA20"].diff().iloc[-1]) * s < 0
    second = first and (c.close < lo if top else c.close > hi) and ema_turn
    word = "波峰" if top else "波谷"
    basis = (f"① {'满足' if first else '不满足'}（最近{word} {_f(pivot.price)}）；② {'满足' if second else '不满足'}")
    return _met(first and second, basis, {f"最近{word}": pivot.price, "EMA20": float(c.row["EMA20"])})


def p7_accel_no_chase(c: Ctx) -> Result:
    t = c.regime.type
    return _met(t in (TrendType.ACCEL_UP, TrendType.ACCEL_DOWN), "加速中，没仓位不参与" if c.regime.accel else "不是加速")


def p8_accel_hold(c: Ctx) -> Result:
    if c.regime.accel is None:
        return _met(False, "不是加速")
    up = c.regime.type == TrendType.ACCEL_UP
    k = _construct(c, top=up)
    if k.status == Status.CHART:
        return k
    name = "顶部构造" if up else "底部构造"
    return _met(k.status == Status.UNMET, f"{name}{'没完成' if k.status == Status.UNMET else '已完成'}", k.levels)


def p9_accel_key_swing(c: Ctx) -> Result:
    if c.regime.accel is None:
        return _met(False, "不是加速")
    held = p8_accel_hold(c)
    if held.status == Status.CHART:
        return held
    swing = j19_key_swing(c)
    return _met(held.status == Status.UNMET, f"构造已出现，等关键性波动：{swing.basis}" if held.status == Status.UNMET
                else "构造还没出现", swing.levels)


def _pullback_dir(c: Ctx) -> int:
    return {TrendType.STEADY_UP: 1, TrendType.STEADY_DOWN: -1}.get(c.regime.type, 0)


def p10_parallel(c: Ctx) -> Result:
    d = _pullback_dir(c)
    return _met(d != 0, f"{c.regime.name}，60 线 {c.regime.clock60.hour}" if d else f"不是稳定趋势（{c.regime.name}）")


def _pullback_start(c: Ctx, d: int) -> pd.Timestamp | None:
    """这次回撤（反弹）从哪根开始：最近的波峰（波谷）之后最高价最高（最低价最低）的那根；又创新高就从新高重新算。"""
    pivot = c.structure.last_high if d > 0 else c.structure.last_low
    if pivot is None:
        return None
    since = c.df.loc[pivot.date:]
    return since["High"].idxmax() if d > 0 else since["Low"].idxmin()


def p11_pullback_reach(c: Ctx) -> Result:
    d = _pullback_dir(c)
    if not d:
        return _met(False, f"不是稳定趋势（{c.regime.name}）")
    if c.structure is None:
        return Result(Status.CHART, "没有最高价、最低价，定不出这次回撤从哪开始")
    word = "回撤" if d > 0 else "反弹"
    start = _pullback_start(c, d)
    if start is None:
        return _met(False, f"还没有{'波峰' if d > 0 else '波谷'}，没有这次{word}")
    w = c.df.loc[start:]
    group = w[["MA60", "EMA60"]].max(axis=1) if d > 0 else w[["MA60", "EMA60"]].min(axis=1)
    hits = w.index[(w["Close"] <= group) if d > 0 else (w["Close"] >= group)]
    h = hurdle_path(c.df, 120, HURDLE_DAYS[120])
    keep = h.max_price < c.close if d > 0 else h.min_price > c.close
    edge = h.max_price if d > 0 else h.min_price
    reached = f"{hits[0].date()} 起到过" if len(hits) else "没到过"
    basis = (f"这次{word}（{start.date()} 起）{reached} 60 线组；MA120 {h.days} 天抵扣价{'最高' if d > 0 else '最低'} "
             f"{_f(edge)}（{_pct(edge, c.close)}），收盘不变{'方向不变' if keep else '会拐头'}")
    return _met(len(hits) > 0 and keep, basis,
                {"60 线组": float(group.iloc[-1]), f"MA120 {h.days} 天抵扣价{'最高' if d > 0 else '最低'}": edge})


def p12_pullback_construct(c: Ctx) -> Result:
    d = _pullback_dir(c)
    if not d:
        return _met(False, f"不是稳定趋势（{c.regime.name}）")
    k = _construct(c, top=d < 0)
    if k.status == Status.CHART:
        return k
    start = _pullback_start(c, d)
    since = None if start is None else str(start.date())
    pivot = (c.structure.bottom if d > 0 else c.structure.top)
    fresh = pivot is not None and since is not None and pivot.pivot_date >= since
    ok = k.status == Status.MET and fresh
    tail = "" if fresh or since is None else f"（但早于这次{'回撤' if d > 0 else '反弹'} {since}）"
    return _met(ok, k.basis + tail, k.levels)


def p13_hourly_arrangement(c: Ctx) -> Result:
    h = c.hourly or {}
    if not h.get("available"):
        return Result(Status.CHART, f"没有小时线（{h.get('reason', '没有取')}），看图")
    want = "空头" if (_pullback_dir(c) or c.regime.direction) < 0 else "多头"
    ok = h["arr_ma"] == want and h["arr_ema"] == want
    return _met(ok, f"小时线（{h['source']}，到 {h['last']}）MA {h['arr_ma']}、EMA {h['arr_ema']}，要{want}排列",
                {f"小时 {k}{line['period']}": line[k.lower()] for line in h["lines"] for k in ("MA", "EMA")})


def p14_pullback_entry(c: Ctx) -> Result:
    conds = [p10_parallel(c), p11_pullback_reach(c), p12_pullback_construct(c), p13_hourly_arrangement(c)]
    marks = "；".join(f"{i} {r.status.value}" for i, r in zip(("①", "②", "③", "④"), conds))
    if any(r.status == Status.UNMET for r in conds):
        return _met(False, marks)
    if any(r.status == Status.CHART for r in conds):
        return Result(Status.CHART, marks)
    return _met(True, marks)


def p16_bounce_exit(c: Ctx) -> Result:
    bear = _side(c.p20) < 0 and c.p20.completed is not None
    moving = bear and c.p20.current is not None and c.p20.current.progress > 0
    undone = moving and not _has(c.p20.current, Step.DOUBLE_CROSS)
    basis = (f"20/60 {c.p20.completed.steps[-1].date} 双死叉，反弹没解除" if undone
             else "不是双死叉之后的反弹")
    return _met(undone, basis, {"EMA60": float(c.row["EMA60"]), "MA60": float(c.row["MA60"])} if undone else {})


def p17_no_buy_bad_order(c: Ctx) -> Result:
    under = c.row["MA20"] < c.row["MA60"] and c.row["EMA20"] < c.row["EMA60"]
    if not under:
        return _met(False, "20 线组不在 60 线组下方")
    short, short_levels = _align_level(c, True, 10)
    long, long_levels = _align_level(c, True, 30)
    return _met(True, f"20 线组在 60 线组下方，不买；理顺（带方向）{short}；{long}",
                {**short_levels, **long_levels})


def p18_not_in_sync(c: Ctx) -> Result:
    d = c.df[["MA20", "EMA20"]].diff().iloc[-1]
    ok = c.close < c.row["EMA20"] and d["EMA20"] < 0 and d["MA20"] > 0
    return _met(ok, f"收盘{'低' if c.close < c.row['EMA20'] else '高'}于 EMA20，EMA20 {_dir(d['EMA20'])}、MA20 {_dir(d['MA20'])}",
                {"EMA20": float(c.row["EMA20"])})


def _fresh_turn_up(col: pd.Series) -> bool:
    d = col.diff().iloc[-FRESH_BARS - 1:]
    return bool(d.iloc[-1] > 0 and (d.iloc[:-1] < 0).any())


def p19_first_chance(c: Ctx) -> Result:
    ok = c.close > c.row["EMA20"] and _fresh_turn_up(c.df["EMA20"])
    return _met(ok, f"收盘{'站上' if c.close > c.row['EMA20'] else '在'} EMA20 {_f(c.row['EMA20'])}"
                + ("，EMA20 刚拐上来" if ok else ""), {"EMA20": float(c.row["EMA20"])})


def p20_second_chance(c: Ctx) -> Result:
    drop = float(c.df["Close"].iloc[-21])   # 今天扣掉的那根：20 天前
    ok = c.close > drop and _fresh_turn_up(c.df["MA20"])
    return _met(ok, f"收盘{'高' if c.close > drop else '低'}于 20 天前的 {_f(drop)}" + ("，MA20 刚拐上来" if ok else ""),
                {"MA20 明天抵扣价": float(c.df["Close"].iloc[-20])})


# ---------- 筹码分布（视频 O）：统计区间固定为最近 1 年，见 volprofile.py ----------

def _band(m: Mountain) -> str:
    return f"{_f(m.foot)}–{_f(m.top)}"


def _no_volume() -> Result:
    return Result(Status.CHART, "数据里没有最高价、最低价或成交量，算不了筹码分布")


def _with_mountains(c: Ctx) -> tuple[Profile | None, Result | None]:
    p = c.profile
    if p is None:
        return None, _no_volume()
    if not p.mountains:
        return None, _met(False, f"{p.start} ~ {p.end} 没有哪一档的量高过平均，没有筹码山")
    return p, None


def j45_profile(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    big = p.largest()
    return _met(True, f"{p.start} ~ {p.end}（{p.bars} 根，和图默认的 1 年同一段）按价格分 {len(p.volumes)} 档："
                      f"{len(p.mountains)} 座筹码山，最大的 {_band(big)}（占 {big.share:.0%}）",
                {"最大筹码山 山脚": big.foot, "最大筹码山 山顶": big.top})


def j46_foot_top(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    mts = "；".join(f"山脚 {_f(m.foot)}、山顶 {_f(m.top)}（{m.share:.0%}）" for m in p.mountains)
    return _met(True, f"量降到平均以下就出了山（PROFILE_EDGE）：{mts}")


def j47_bounce_target(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    up = p.above(c.close)
    if not up:
        return _met(False, f"收盘 {_f(c.close)} 上方没有整座的筹码山")
    m = up[0]
    return _met(True, f"上方最近的筹码山 {_band(m)}：反弹的目标区间是这条带。J47 说的是超跌反弹，现在是{c.regime.name}",
                {"山脚": m.foot, "山顶": m.top})


def j48_over_the_top(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    big = p.largest()
    prev = float(c.df["Close"].iloc[-2])
    lv = {"最大筹码山 山顶": big.top}
    if c.close > big.top:
        when = "今天刚翻过去" if prev <= big.top else "已经在山顶上方"
        return _met(True, f"收盘 {_f(c.close)} 在最大那座山 {_band(big)}（占 {big.share:.0%}）的山顶上方，{when}", lv)
    where = "里" if c.close >= big.foot else "下方"
    return _met(False, f"收盘 {_f(c.close)} 在最大那座山 {_band(big)}（占 {big.share:.0%}）{where}，还没翻过山顶", lv)


def j49_mountain_side(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    up, down = sum(m.share for m in p.above(c.close)), sum(m.share for m in p.below(c.close))
    split = f"整座在上方的筹码山占 {up:.0%}，在下方的占 {down:.0%}"
    if up > down:
        return _met(True, f"{split}：主要筹码在价格上方，往上是爬山，越近山顶越难")
    if down > up:
        return _met(False, f"{split}：主要筹码在价格下方，山路轻松（镜像）")
    return _met(False, f"{split}：上下一样多")


def p39_in_mountain(c: Ctx) -> Result:
    p, out = _with_mountains(c)
    if out:
        return out
    m = p.containing(c.close)
    if m is None:
        return _met(False, f"收盘 {_f(c.close)} 不在哪座筹码山里")
    if c.plan is None:
        return _no_plan()
    from tradeplan import holds_past_target   # tradeplan 导入本模块，这里晚一点导入
    key = c.plan.key
    then = ("中长线完好，继续拿，按止损和失效离场" if holds_past_target(key)
            else "中长线不完好，在山里走")
    return _met(True, f"收盘 {_f(c.close)} 在筹码山 {_band(m)} 里：照 P25，现在是{key}，{then}",
                {"山脚": m.foot, "山顶": m.top})


# ---------- 交易计划：价位在 tradeplan.build，这里只把空仓那份计划写成规则状态 ----------

def _no_plan() -> Result:
    return Result(Status.CHART, "没有交易计划（没跑 tradeplan.build）")


def a6_position_size(c: Ctx) -> Result:
    if c.plan is None:
        return _no_plan()
    f = c.plan.flat
    if f.size is None:
        why = next((n for n in f.notes if "股数" in n or "止损" in n), "空仓这套打法不买")
        return Result(Status.MET, f"今天套用不了：{why}")
    z = f.size
    return Result(Status.MET, z.basis, {"单位亏损": z.unit_risk})   # levels 只放价位，股数在 basis 和 trade_plan 里


def p22_breakout_stop(c: Ctx) -> Result:
    if c.plan is None:
        return _no_plan()
    s = c.plan.flat.stop
    if s is None or s.rule != "P22":
        return _met(False, "没有突破买入（只用于突破买入）")
    return _met(True, s.reason, {"起涨 K 线最低价": s.price})


def p23_exit_by_entry(c: Ctx) -> Result:
    if c.plan is None:
        return _no_plan()
    f, h = c.plan.flat, c.plan.holding
    stop = f.stop if f.entry is not None and f.entry.price is not None else h.stop
    if stop is None:
        return _met(False, "空仓不买，持仓也没有均线止损" if f.entry is None else "进场条件还没有价位")
    who = "空仓进场后" if stop is f.stop else "持仓"
    return _met(True, f"{who}：{stop.reason}", {} if stop.price is None else {"止损": stop.price})


def p24_reward_risk(c: Ctx) -> Result:
    """满足 = 盈亏比不到 3:1，不做（和 P17"排列不合理不买"满足就不买一样读）。"""
    if c.plan is None:
        return _no_plan()
    f = c.plan.flat
    if f.entry is None or f.entry.price is None:
        return _met(False, "空仓这套打法今天没有进场价，不用算盈亏比")
    if f.rr is None:
        return Result(Status.CHART, "盈亏比算不了：" + ("；".join(f.notes) or "没有目标位或止损"))
    lv = {"进场": f.entry.price, "止损": f.stop.price, "目标 1": f.targets[0].price}
    if f.rr_verdict == "不做":
        return _met(True, f"{f.rr:.2f}:1 < 3:1，不做；要 3:1 目标得到 {_f(f.rr_gap['target_for_min'])}，"
                          f"或止损收紧到 {_f(f.rr_gap['stop_for_min'])}", lv)
    return _met(False, f"{f.rr:.2f}:1，{f.rr_verdict}（≥ 3:1 可做，≥ 5:1 理想）", lv)


def _target_plan(c: Ctx) -> TradePlan:
    """P25、P38 看哪份计划：空仓有进场价看空仓的，否则看持仓的。"""
    f = c.plan.flat
    return f if f.entry is not None and f.entry.price is not None else c.plan.holding


def _target_text(t: Target) -> str:
    return f"{t.kind} {_f(t.price)}–{_f(t.top)}" if t.top is not None else f"{t.kind} {_f(t.price)}"


def p25_targets(c: Ctx) -> Result:
    if c.plan is None:
        return _no_plan()
    p = _target_plan(c)
    if not p.targets:
        return _met(False, next((n for n in p.notes if "目标" in n), "上方没有目标位"))
    basis = "；".join(f"目标 {i} {_target_text(t)}（{t.date}）" for i, t in enumerate(p.targets, 1))
    return _met(True, f"{basis}。{p.at_target}", {f"目标 {i}": t.price for i, t in enumerate(p.targets, 1)})


def p38_profile_target(c: Ctx) -> Result:
    if c.plan is None:
        return _no_plan()
    p = _target_plan(c)
    hit = next(((i, t) for i, t in enumerate(p.targets, 1) if t.kind == "筹码山"), None)
    if hit:
        i, t = hit
        return _met(True, f"目标 {i} 是筹码山：山脚 {_f(t.price)} 到山顶 {_f(t.top)} 这条带（J47，{t.date}）",
                    {"山脚": t.price, "山顶": t.top})
    if c.profile is None:
        return _no_volume()
    ref = p.entry.price if p is c.plan.flat else c.close
    up = c.profile.above(ref)
    if not up:
        return _met(False, f"{'进场价' if p is c.plan.flat else '现价'} {_f(ref)} 上方没有整座的筹码山")
    nearer = f"，比它近的是{_target_text(p.targets[0])}" if p.targets else ""
    return _met(False, f"上方最近的筹码山 {_band(up[0])} 不是第一目标{nearer}")


RULES: tuple[Rule, ...] = (
    Rule("A1", Kind.AXIOM, "MA 的门槛是抵扣价", a1_ma_hurdle),
    Rule("A2", Kind.AXIOM, "MA 的门槛路径", a2_hurdle_path),
    Rule("A3", Kind.AXIOM, "EMA 的门槛是线本身", a3_ema_line),
    Rule("A4", Kind.AXIOM, "单根线 EMA 先拐、MA 后拐", a4_ema_first),
    Rule("A5", Kind.AXIOM, "趋势由小级别向大级别扩散", None),
    Rule("A6", Kind.AXIOM, "仓位公式：最大亏损额 ÷ 单位亏损", a6_position_size),
    Rule("J1", Kind.VERDICT, "类型看 60/120 线组", j1_type_from_60_120),
    Rule("J2", Kind.VERDICT, "钟表方向：固定时长、对数坐标", j2_clock),
    Rule("J3", Kind.VERDICT, "加速上涨 / 加速下跌", j3_accel),
    Rule("J4", Kind.VERDICT, "稳定上涨 / 稳定下跌", j4_steady),
    Rule("J5", Kind.VERDICT, "横盘", j5_range),
    Rule("J6", Kind.VERDICT, "定不出类型时的过渡状态", j6_transition),
    Rule("J7", Kind.VERDICT, "阶段看 20 线组和价格", j7_stage),
    Rule("J8", Kind.VERDICT, "加速出现在趋势两头", j8_accel_where),
    Rule("J9", Kind.VERDICT, "加速的后果一：回归成本", j9_regress),
    Rule("J10", Kind.VERDICT, "加速的后果二：持续放量要转向", j10_volume_turn),
    Rule("J11", Kind.VERDICT, "横盘后方向跟周线", j11_weekly_direction),
    Rule("J12", Kind.VERDICT, "横盘末期①：不少于 6 个月", j12_range_long_enough),
    Rule("J13", Kind.VERDICT, "横盘末期②：均线相差 < 2%", j13_range_dense),
    Rule("J14", Kind.VERDICT, "横盘末期③：均线张嘴", j14_range_opening),
    Rule("J15", Kind.VERDICT, "转折三步：破线、拐头、交叉", j15_three_steps),
    Rule("J16", Kind.VERDICT, "双交叉是同一对周期的 MA 和 EMA 都交叉", j16_double_cross),
    Rule("J17", Kind.VERDICT, "另一组距离很大，是假动作", j17_fake_move),
    Rule("J18", Kind.VERDICT, "排列不合理", j18_bad_order),
    Rule("J19", Kind.VERDICT, "关键性波动", j19_key_swing),
    Rule("J20", Kind.VERDICT, "顶部构造", j20_top_construct),
    Rule("J21", Kind.VERDICT, "底部构造", j21_bottom_construct),
    Rule("J22", Kind.VERDICT, "构造被破坏", j22_construct_broken),
    Rule("J23", Kind.VERDICT, "没有顶部构造就不会见顶", j23_no_construct_no_top),
    Rule("J24", Kind.VERDICT, "波段", j24_swing),
    Rule("J25", Kind.VERDICT, "M 顶 / W 底", j25_m_w),
    Rule("J26", Kind.VERDICT, "2B", j26_2b),
    Rule("J27", Kind.VERDICT, "提前算构造", j27_complete_at),
    Rule("J28", Kind.VERDICT, "真突破让人追不上", None),
    Rule("J29", Kind.VERDICT, "大行情要有排列配合", j29_arrangement),
    Rule("J30", Kind.VERDICT, "某周期出了前三步就假定在走好", None),
    Rule("J31", Kind.VERDICT, "小周期多头走出来", None),
    Rule("J32", Kind.VERDICT, "小周期不破坏排列，大一级会完成前三步", None),
    Rule("J33", Kind.VERDICT, "周期共振", None),
    Rule("J34", Kind.VERDICT, "看周线拐头先看日线均线密集", None),
    Rule("J35", Kind.VERDICT, "长期 MA 拐不下来，市场会强行逆转", None),
    Rule("J36", Kind.VERDICT, "引力回归", None),
    Rule("J37", Kind.VERDICT, "乖离阈值：EMA120 50%、周线 70%", j37_extreme_bias),
    Rule("J38", Kind.VERDICT, "方框时间内拿下山头", None),
    Rule("J39", Kind.VERDICT, "2B 只解决回归", None),
    Rule("J40", Kind.VERDICT, "周线均线密集至少翻倍", None),
    Rule("J41", Kind.VERDICT, "没有标志性动作趋势不会改变", None),
    Rule("J42", Kind.VERDICT, "突破多次试探的位置，占领筹码峰", None),
    Rule("J43", Kind.VERDICT, "分歧越大，确定性越强", None),
    Rule("J44", Kind.VERDICT, "收盘高于所有爆量日，恐怕要往上", None),
    Rule("J45", Kind.VERDICT, "筹码分布：按价格统计的成交量，每座山峰是密集成交区", j45_profile),
    Rule("J46", Kind.VERDICT, "山脚、山顶是筹码山的价格下沿、上沿", j46_foot_top),
    Rule("J47", Kind.VERDICT, "超跌反弹的目标是上方最近那座筹码山", j47_bounce_target),
    Rule("J48", Kind.VERDICT, "收盘翻过山顶，可能开启大行情", j48_over_the_top),
    Rule("J49", Kind.VERDICT, "筹码山在上方爬山难，在下方山路轻松", j49_mountain_side),
    Rule("P1", Kind.ACTION, "横盘中段不做", p1_range_wait),
    Rule("P2", Kind.ACTION, "横盘末期埋伏", p2_ambush),
    Rule("P3", Kind.ACTION, "埋伏的底线", p3_ambush_stop),
    Rule("P4", Kind.ACTION, "磨蹭就走", None),
    Rule("P5", Kind.ACTION, "假突破先出局", p5_fake_breakout),
    Rule("P6", Kind.ACTION, "假跌破空单止损", p6_fake_breakdown),
    Rule("P7", Kind.ACTION, "加速没仓位不参与", p7_accel_no_chase),
    Rule("P8", Kind.ACTION, "加速有仓位，没构造不下车", p8_accel_hold),
    Rule("P9", Kind.ACTION, "见了构造，等关键性波动再动手", p9_accel_key_swing),
    Rule("P10", Kind.ACTION, "吃回撤①：中长期均线平行", p10_parallel),
    Rule("P11", Kind.ACTION, "吃回撤②：回撤到 60/120 线组，MA 方向不变", p11_pullback_reach),
    Rule("P12", Kind.ACTION, "吃回撤③：底部构造", p12_pullback_construct),
    Rule("P13", Kind.ACTION, "吃回撤④：小时级别多头排列", p13_hourly_arrangement),
    Rule("P14", Kind.ACTION, "吃回撤：条件齐了进场", p14_pullback_entry),
    Rule("P15", Kind.ACTION, "第一次回撤到线组是好入场点", None),
    Rule("P16", Kind.ACTION, "解除不了双交叉，反弹是离场机会", p16_bounce_exit),
    Rule("P17", Kind.ACTION, "排列不合理不买", p17_no_buy_bad_order),
    Rule("P18", Kind.ACTION, "MA、EMA 不协同时保护", p18_not_in_sync),
    Rule("P19", Kind.ACTION, "双线系统第 1 次机会", p19_first_chance),
    Rule("P20", Kind.ACTION, "双线系统第 2 次机会", p20_second_chance),
    Rule("P21", Kind.ACTION, "突破买入", None),
    Rule("P22", Kind.ACTION, "突破买入的止损：起涨 K 线最低价", p22_breakout_stop),
    Rule("P23", Kind.ACTION, "什么原则进，就什么原则出", p23_exit_by_entry),
    Rule("P24", Kind.ACTION, "盈亏比不到 3:1 不做", p24_reward_risk),
    Rule("P25", Kind.ACTION, "目标位：缺口和均线密集区；到第一目标中长线完好就继续拿", p25_targets),
    Rule("P26", Kind.ACTION, "预期没到、底线没破就拿着", None),
    Rule("P28", Kind.ACTION, "前高过不去是止盈点", None),
    Rule("P29", Kind.ACTION, "标志性动作当参考点", None),
    Rule("P30", Kind.ACTION, "在门槛价设买入提醒", None),
    Rule("P31", Kind.ACTION, "抵扣价突然下降处狙击", None),
    Rule("P32", Kind.ACTION, "急跌后假跌破，破线拐头合二为一", None),
    Rule("P33", Kind.ACTION, "下跌后只认 2B 和下一级别均线密集", None),
    Rule("P34", Kind.ACTION, "目光随扩散上移", None),
    Rule("P35", Kind.ACTION, "走不好在原级别解决", None),
    Rule("P36", Kind.ACTION, "周期共振第一时间反应", None),
    Rule("P37", Kind.ACTION, "周线 2B 先看日线呼应", None),
    Rule("P38", Kind.ACTION, "筹码山也是目标位来源，和缺口、均线密集并列", p38_profile_target),
    Rule("P39", Kind.ACTION, "进了目标筹码山照 P25 看中长线", p39_in_mountain),
    Rule("P40", Kind.ACTION, "黑绿线：20 在 60 上方，绿色做多", None),
    Rule("P41", Kind.ACTION, "黑绿线：20 在 60 上方，变黑平仓不做空", None),
    Rule("P42", Kind.ACTION, "黑绿线：20 在 60 下方，黑色做空", None),
    Rule("P43", Kind.ACTION, "黑绿线：20 在 60 下方，变绿平仓不做多", None),
    Rule("P44", Kind.ACTION, "黑绿线：灰色不做动作", None),
)
BY_ID = {r.id: r for r in RULES}

# 两条规则同时满足、结论相反时谁说了算：键让位给值里第一条满足的规则（rules.md P17、P16、P24）
YIELDS_TO = {"P19": ("P17", "P16", "P24"), "P20": ("P17", "P16", "P24"), "P2": ("P24",), "P14": ("P24",)}


def evaluate(ctx: Ctx) -> list[dict]:
    results = {r.id: (r.evaluate(ctx) if r.evaluate else Result(Status.CHART, "脚本算不了")) for r in RULES}

    def yields_to(rid: str) -> str | None:
        if results[rid].status != Status.MET:
            return None
        return next((o for o in YIELDS_TO.get(rid, ()) if results[o].status == Status.MET), None)

    return [{"id": r.id, "kind": r.kind.value, "name": r.name, "status": results[r.id].status.value,
             "basis": results[r.id].basis, "levels": results[r.id].levels, "yields_to": yields_to(r.id)}
            for r in RULES]


# ---------- 打法：唯一出口 ----------

PLAY_KEYS = ("横盘", "稳定上涨", "加速上涨", "稳定下跌", "加速下跌", "多头结构回撤中", "空头结构反弹中", "过渡")


def play_key(regime: Regime) -> str:
    if regime.type is None:
        return {Transition.BULL_PULLBACK: "多头结构回撤中", Transition.BEAR_BOUNCE: "空头结构反弹中"}.get(regime.transition, "过渡")
    if regime.stage == Stage.TURNING:
        return "过渡"
    return regime.type.value


def build_play(regime: Regime, results: list[dict]) -> dict:
    """由类型、阶段和规则结果生成唯一一段打法。rules 列出这段话用到的规则编号。"""
    st = {r["id"]: r for r in results}

    def s(rid: str) -> str:
        return f"{st[rid]['status']}（{rid}）"

    key = play_key(regime)
    if key == "横盘":
        if st["P2"]["status"] == "满足":
            text = "横盘末期三个条件齐了、还没突破：均线刚形成多头排列，小仓位埋伏；20 线组与 60 线组交叉或不可避免要交叉就止损。"
            ids = ["P2", "P3", "J12", "J13", "J14"]
        else:
            text = (f"横盘中段不做。末期条件：①时间 {st['J12']['basis']}，②{st['J13']['basis']}，③{st['J14']['basis']}。"
                    f"视频说方向跟周线走（{st['J11']['basis']}），回测不支持（评估 H5），只当参考。")
            ids = ["P1", "J12", "J13", "J14", "J11"]
    elif key in ("稳定上涨", "稳定下跌"):
        up = key == "稳定上涨"
        conds = f"① {s('P10')}，② {s('P11')}，③ {s('P12')}，④ {s('P13')}"
        entry = st["P14"]["status"]
        if regime.stage == Stage.EXTEND:
            text = (f"{regime.name}：持有，不追高。等回撤：到 60 线组、MA120 方向不变、出现底部构造、小时线多头排列，再加仓。"
                    if up else
                    f"{regime.name}：不抄底。等反弹：到 60 线组、MA120 方向不变、出现顶部构造、小时线空头排列，再减仓或离场。")
        elif up:
            text = f"{regime.name}：持有，不追高。吃回撤：{conds}。" + {
                "满足": "四个条件齐了，可以结构性加仓。",
                "需看图": "前三条都满足，看图确认小时线走出多头排列就加仓。",
            }.get(entry, "条件没齐，先不加仓。")
        else:
            text = f"{regime.name}：不抄底。反弹卖出：{conds}。" + {
                "满足": "四个条件齐了，有仓位减仓或离场。",
                "需看图": "前三条都满足，看图确认小时线走出空头排列就减仓或离场。",
            }.get(entry, "条件没齐，有仓位等反弹到线组附近再减。")
        ids = ["P10", "P11", "P12", "P13", "P14"]
    elif key in ("加速上涨", "加速下跌"):
        up = key == "加速上涨"
        phase = regime.accel.phase if regime.accel else ""
        if up:
            text = (f"加速上涨（{phase}）：没仓位不追。有仓位：" +
                    ("顶部构造没出现，拿着不下车。" if st["P8"]["status"] == "满足"
                     else "顶部构造已出现，只是提醒；等关键性波动（20 线组拐头）再走。"))
        else:
            text = (f"加速下跌（{phase}）：不抢反弹。等底部构造（J21 {st['J21']['status']}）"
                    "和关键性波动（20 线组拐头向上）。")
        if st["J37"]["status"] == "满足":
            text += f"大幅乖离（J37，旁证）：{st['J37']['basis'].split('；')[0]}，很可能要回归，什么时候回归不知道。"
        ids = ["P7", "P8", "P9", "J19", "J20" if up else "J21", "J37"]
    elif key == "空头结构反弹中":
        text = (f"空头结构反弹中：不买。20 线组还在 60 线组下方，反弹解除不了双死叉，是离场机会。"
                f"{st['P17']['basis'].split('；', 1)[-1]}。")
        ids = ["P17", "P16", "J17", "J18"]
    elif key == "多头结构回撤中":
        text = "多头结构回撤中：结构还是多头，持有观察，20/60 双死叉才算坏。没仓位等收盘站上 EMA20、MA20 重新拐头向上再买。"
        ids = ["J16", "P19", "P20"]
    else:
        text = f"{regime.name}：排列没理顺，条件不满足就不做。有仓位，收盘跌破 EMA20、EMA20 拐头向下就减。"
        ids = ["J6", "J15", "P18"]
    return {"key": key, "text": text, "rules": ids}
