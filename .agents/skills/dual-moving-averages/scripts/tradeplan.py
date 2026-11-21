"""交易计划：把打法变成能直接下单的五样东西：进场、止损、目标位、盈亏比、股数。

规则文字和出处在 references/rules.md（A6、P22–P25）。每份计划算一次，JSON 的 trade_plan 给网页和长风读，
它们不重算。空仓一份（flat）、持仓一份（holding）：持仓没有进场和股数，止损按进场的原则给，不按成本。

- 进场：打法会买时才有（横盘埋伏或突破、稳定上涨吃回撤、多头结构回撤中和加速下跌的 20 线组拐头）。
- 止损：什么原则进就什么原则出（P23）。突破买入在起涨 K 线最低价（P22）；20 线组拐头进场的，
  拐头失败就止损，价位用 EMA20 和抵扣价算；吃回撤是 60 线组拐头（视频没给价位，标"解读"）。
- 目标位（P25）：上方最近的缺口或均线密集（20、60 汇在一起也算），下一个是 20/60/120 全部汇聚处。
  上方都没有时用最近的波峰（前高，解读）。下跌趋势（稳定下跌、加速下跌）的持仓不找目标：P25 是拐头向上以后的事，
  这时持仓按反弹减仓、离场。
- 筹码山（P38）：上方最近的整座筹码山记在计划的 mountain 上，只作参考价位，不排进目标、不算盈亏比
  （docs/adr/0018.md）。
- 到第一目标是检查点（P25）：中长线（60/120）完好就继续拿，按止损和失效离场；不完好就在目标位走。
  完好的判断只在这里（holds_past_target），回测（fullplan、plansim）和网页都读它。
- 盈亏比 = (第一目标 − 进场) ÷ (进场 − 止损)。< 3 不做，≥ 5 理想（P24）。
- 触发价离现价还远（docs/adr/0026.md）：20 线组拐头的触发价只看明天的抵扣价。按收盘持平推演，TURN_DAYS 天内
  两条一起拐头的最低价位比它低 FAR_PCT 以上时，进场记下推演（entry.far），盈亏比显示成"到时重算"。
  进场价、止损、rr、rr_verdict 照旧按明天算：回测每天重算计划、挂明天的单，读的就是这几个。
- 股数 = 每笔可承受亏损 ÷ (进场 − 止损)，向下取整（A6）。没填账户只给每 1 万元风险对应多少股。
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import pandas as pd

import rules as rl
from projection import Event, EventKind, SolveStatus, extend, solve
from regime import CLOCK_WINDOW, DENSE_PCT
from structure import Structure
from volprofile import Profile

RR_MIN = 3.0             # 视频 I 13:01：小于 3:1 不参与
RR_IDEAL = 5.0           # 视频 I 13:06：至少 5:1 或更高
RISK_UNIT = 10_000       # 没填账户时：每 1 万元风险对应多少股
TICK = 0.01              # 美股最小报价单位：进场和止损相差不到 1 分钱，止损没法执行
HOLD_STOP_DAYS = 30      # 多头结构回撤中持仓的止损：30 天内避免 20/60 双死叉（和推演的跨度一样）
# 脚本自定（docs/adr/0026.md）：触发价离现价还远的判断
TURN_DAYS = 10           # 推演 20 线组一起拐头看几天：推演求解最短的跨度（SOLVE_DAYS），也是 MA20 窗口的一半
FAR_PCT = 2.0            # 明天的触发价比推演门槛高出这么多（%）算远：和均线"相差 < 2% 算密集"（DENSE_PCT）同一个尺度
RR_FAR = "触发价离现价还远，到时重算"


@dataclass(frozen=True)
class FarTrigger:
    """按收盘持平推演，TURN_DAYS 天内 MA20、EMA20 同一天都向上的最低价位，和持平在那里时最早哪天一起向上。"""
    level: float
    day: int               # 第几个交易日（推演的第 k 天，k 从 1 起）
    days: int              # 推演跨度 TURN_DAYS


@dataclass(frozen=True)
class Entry:
    price: float | None    # 进场触发价；条件里没有日线价位（等小时线、等末期条件）时为 None
    condition: str
    rule: str
    far: FarTrigger | None = None   # 触发价离现价还远时的推演；只给显示用，回测不读


@dataclass(frozen=True)
class Stop:
    price: float | None
    reason: str
    rule: str
    source: str            # 视频：视频给了定价位的办法；解读：视频没给价位，脚本按原则放的


@dataclass(frozen=True)
class Target:
    price: float
    kind: str              # 缺口 / 20、60 均线密集 / 20、60、120 全部汇聚 / 前高
    rule: str
    source: str
    date: str | None       # 缺口、密集区形成的日子（前高是波峰那天）


@dataclass(frozen=True)
class PlanMountain:
    """上方最近的整座筹码山（P38）：参考价位，是 [山脚, 山顶] 一条带（J47），不是目标。"""
    foot: float
    top: float
    date: str              # 筹码分布的统计区间，"开始~结束"


@dataclass(frozen=True)
class Size:
    shares: int | None     # 没填账户时为 None，看 per_10k
    risk_amount: float | None
    per_10k: int           # 每 1 万元风险对应多少股
    unit_risk: float       # 进场 − 止损
    capped: bool           # 按风险算的股数买不起，按账户能买的最多股数给
    basis: str


@dataclass(frozen=True)
class TradePlan:
    entry: Entry | None
    stop: Stop | None
    targets: list[Target]
    rr: float | None
    rr_verdict: str | None        # 不做 / 可做 / 理想
    rr_gap: dict | None           # 不做时：要 3:1，目标得到哪、或止损得收紧到哪
    risk_pct: float | None        # 进场（持仓：现价）到止损的距离，占进场价 %
    size: Size | None
    at_target: str | None = None  # 到第一目标怎么办（P25）；没有目标时为 None
    notes: list[str] = field(default_factory=list)
    mountain: PlanMountain | None = None   # 上方最近的筹码山，只作参考（P38）；上方没有整座的山时为 None


@dataclass(frozen=True)
class PlanSet:
    key: str                      # 打法键：rules.play_key，横盘里埋伏的底线已破（P3 满足）时是"横盘破位"
    flat: TradePlan
    holding: TradePlan


@dataclass(frozen=True)
class Sizing:
    """每笔可承受亏损：填了金额用金额，否则按账户的比例（默认 1%）。都没有就只给每 1 万元风险的股数。"""
    account: float | None = None
    risk_pct: float = 1.0
    risk_amount: float | None = None

    def amount(self) -> float | None:
        if self.risk_amount:
            return self.risk_amount
        return self.account * self.risk_pct / 100 if self.account else None


def _f(x: float) -> str:
    return f"{x:.2f}"


# ---------- 纯计算：盈亏比、仓位 ----------

def rr_verdict(rr: float | None) -> str | None:
    if rr is None:
        return None
    r = round(rr, 6)   # 只去掉浮点误差：3:1 正好算可做
    return "不做" if r < RR_MIN else ("理想" if r >= RR_IDEAL else "可做")


def reward_risk(entry: float, stop: float, target: float) -> float | None:
    """(目标 − 进场) ÷ (进场 − 止损)。止损不在进场下方、目标不在进场上方时算不了。"""
    risk, reward = entry - stop, target - entry
    if risk < TICK or reward <= 0:
        return None
    return reward / risk


def size_position(entry: float | None, stop: float | None, sizing: Sizing) -> tuple[Size | None, str | None]:
    """A6：股数 = 可承受亏损 ÷ 单位亏损，向下取整。返回 (仓位, 算不了的原因)。"""
    if entry is None:
        return None, "没有进场价，算不了股数"
    if stop is None:
        return None, "没有止损价，算不了股数（A6 要先定止损）"
    unit = round(entry - stop, 6)   # 价格只到小数点后几位：去掉 10.3 − 10.2 这种浮点误差
    if unit <= 0:
        return None, f"止损 {_f(stop)} 不在进场价 {_f(entry)} 下方，算不了股数"
    if unit < TICK:
        return None, f"进场 {_f(entry)} 和止损 {_f(stop)} 相差不到 1 分钱，止损没法执行"
    per_10k = math.floor(RISK_UNIT / unit + 1e-9)
    amount = sizing.amount()
    if amount is None:
        return Size(None, None, per_10k, unit, False,
                    f"单位亏损 {_f(unit)}；没填账户，每 1 万元风险对应 {per_10k} 股"), None
    shares = math.floor(amount / unit + 1e-9)
    capped = bool(sizing.account) and shares * entry > sizing.account
    if capped:
        shares = math.floor(sizing.account / entry + 1e-9)
    basis = f"{amount:.0f} ÷ 单位亏损 {_f(unit)} = {shares} 股"
    if capped:
        basis = f"按风险能买 {math.floor(amount / unit + 1e-9)} 股，账户只够 {shares} 股（止损离进场很近）"
    return Size(shares, amount, per_10k, unit, capped, basis), None


# ---------- 目标位（P25） ----------

@dataclass(frozen=True)
class Gap:
    date: str              # 跳空那根
    top: float             # 前一根的最低价
    bottom: float          # 没补的那段的底：跳空以来的最高价


def unfilled_gaps(df: pd.DataFrame) -> list[Gap]:
    """还没补上的向下缺口：某根最高价低于前一根最低价，之后最高价一直没回到前一根最低价。"""
    if not {"High", "Low"} <= set(df.columns):
        return []
    hi, lo = df["High"].to_numpy(), df["Low"].to_numpy()
    out = []
    for i in range(1, len(df)):
        if hi[i] >= lo[i - 1]:
            continue
        top, bottom = lo[i - 1], hi[i:].max()
        if bottom < top:
            out.append(Gap(str(df.index[i].date()), float(top), float(bottom)))
    return out


def gaps_json(df: pd.DataFrame) -> list[dict]:
    """JSON 里的 gaps：图上画成从跳空那天到现在的色带。"""
    return [asdict(g) for g in unfilled_gaps(df)]


def gaps_above(df: pd.DataFrame, price: float) -> list[Target]:
    """价格上方没补的缺口，目标是缺口下沿（没补的那段的底）。"""
    return [Target(g.bottom, "缺口", "P25", "视频", g.date) for g in unfilled_gaps(df) if g.bottom > price]


def dense_zones_above(df: pd.DataFrame, price: float) -> list[Target]:
    """下跌途中形成过的均线密集区：线靠在一起（相差 < 价格的 DENSE_PCT）而 MA60 在走低的连续几根，目标是这几根线的平均。

    20、60 两组四条线密集就算（视频 G 39:29 120 线没汇进来也算）；6 条线都密集是"全部汇聚"。正在形成的那段不算。
    形成以后收盘站上过的不算（视频 G 40:03 冲过去了就找下一个目标位）：本轮下跌之前留下、上涨途中已经越过的密集区
    不是这轮的阻力。和缺口一样，补上了就不再是目标。
    """
    lines4 = df[["MA20", "EMA20", "MA60", "EMA60"]]
    lines6 = df[["MA20", "EMA20", "MA60", "EMA60", "MA120", "EMA120"]]
    falling = df["MA60"] < df["MA60"].shift(CLOCK_WINDOW)   # 和 J2 钟表同一个窗口：60 线朝下
    close = df["Close"].to_numpy()
    out = []
    for lines, kind in ((lines4, "20、60 均线密集"), (lines6, "20、60、120 全部汇聚")):
        spread = (lines.max(axis=1) - lines.min(axis=1)) / df["Close"] * 100
        dense = (spread < DENSE_PCT) & falling & lines.notna().all(axis=1)
        run: list[int] = []
        for i, flag in enumerate(list(dense) + [False]):
            if flag:
                run.append(i)
                continue
            if run and run[-1] != len(df) - 1:
                level = float(lines.iloc[run].mean(axis=1).mean())
                if level > price and close[run[-1] + 1:].max() <= level:
                    out.append(Target(level, kind, "P25", "视频", str(df.index[run[-1]].date())))
            run = []
    return out


def find_targets(df: pd.DataFrame, structure: Structure | None, price: float) -> list[Target]:
    """第一个目标：上方最近的缺口或均线密集；第二个：再往上最近的 20/60/120 全部汇聚处。都没有时用最近的波峰（前高）。"""
    found = sorted(gaps_above(df, price) + dense_zones_above(df, price), key=lambda t: t.price)
    if found:
        first = found[0]
        full = [t for t in found if t.kind.startswith("20、60、120") and t.price > first.price]
        return [first] + full[:1]
    if structure is not None:
        high = next((p for p in reversed(structure.pivots) if p.kind == "高" and p.price > price), None)
        if high is not None:
            return [Target(high.price, "前高", "P25", "解读", high.date)]
    return []


def mountain_above(profile: Profile | None, price: float) -> PlanMountain | None:
    """价格上方最近的整座筹码山（P38）；价格已经在山里的那座不算（看 P39）。只作参考，不进 find_targets。"""
    up = profile.above(price) if profile is not None else []
    return PlanMountain(up[0].foot, up[0].top, f"{profile.start}~{profile.end}") if up else None


# ---------- 到第一目标（P25） ----------

# 中长线完好：类型还是稳定上涨或加速上涨（J1 有类型、J3/J4 向上，J7 不在转折中）。打法键（rules.play_key）就是这个判断；
# 横盘、J6 的过渡状态（多头结构回撤中、顶部转折中……）、下跌都不算完好
INTACT_KEYS = frozenset({"稳定上涨", "加速上涨"})


def holds_past_target(key: str) -> bool:
    """到第一目标时（看前一天收盘的打法键）：中长线完好就不走（视频 G 42:14）。"""
    return key in INTACT_KEYS


def at_target_line(key: str, targets: list[Target]) -> str | None:
    if not targets:
        return None
    t1 = _f(targets[0].price)
    if holds_past_target(key):
        return (f"到第一目标 {t1} 不是自动离场：中长线完好（现在是{key}）就继续拿，按止损和失效离场；"
                "到时 60/120 已不是稳定上涨或加速上涨，就在目标位走（P25）")
    return (f"到第一目标 {t1}：现在是{key}，中长线不算完好，到了就在目标位走；"
            "到时已经是稳定上涨或加速上涨，就继续拿，按止损和失效离场（P25）")


# ---------- 每套打法的进场和止损 ----------

def _row(c: rl.Ctx, col: str) -> float:
    return float(c.row[col])


def _drop(c: rl.Ctx, n: int, ahead: int = 0) -> float:
    """MA(n) 第 ahead+1 天要扣的收盘价（ahead=0 是明天的抵扣价）。"""
    return float(c.df["Close"].iloc[-n + ahead])


def far_trigger(df: pd.DataFrame, gate: float) -> FarTrigger | None:
    """明天的触发价 gate 比推演门槛高出 FAR_PCT 以上时给出推演，否则 None。"""
    ema20 = float(df["EMA20"].iloc[-1])
    if gate <= ema20 * (1 + FAR_PCT / 100):
        return None   # 门槛不会低于 EMA20（持平在 EMA20 下方，EMA20 天天向下），不用求解
    event = Event(EventKind.GROUP_TURN_UP, 20)
    res = solve(df, event, TURN_DAYS)
    if res.status != SolveStatus.LEVEL or gate <= res.level * (1 + FAR_PCT / 100):
        return None
    together = event.state(extend(df, [res.level] * TURN_DAYS), TURN_DAYS).tolist()
    return FarTrigger(res.level, together.index(True) + 1, TURN_DAYS)


def far_text(far: FarTrigger, gate: float) -> str:
    return f"按收盘持平推演，20 线组最早约 {far.day} 个交易日后、收盘站上 {_f(far.level)} 才会一起拐头；明天要拐头得站上 {_f(gate)}"


def _turn20(c: rl.Ctx, rule: str, extra: float | None = None, extra_text: str = "") -> tuple[Entry, Stop]:
    """20 线组拐头向上进场：收盘站上 EMA20 和 MA20 抵扣价中较高的那个（两条都拐上来）。

    止损是拐头失败（P23）：进场后收盘跌回 EMA20 和进场次日抵扣价中较低的那个之下，两条线又都向下。
    触发价是明天的；离推演门槛还远时记下推演（far_trigger），进场价不变。
    """
    ema20, drop, next_drop = _row(c, "EMA20"), _drop(c, 20), _drop(c, 20, 1)
    gate = max(ema20, drop)
    price = max(gate, c.close)
    if extra is not None and extra > price:
        price = extra
    far = far_trigger(c.df, gate) if c.close < gate == price else None
    cond = (f"{far_text(far, gate)}（推演求解，辅助，评估 H4）" if far is not None
            else f"收盘站上 EMA20 {_f(ema20)} 和 MA20 抵扣价 {_f(drop)}，20 线组一起拐头向上" if c.close < gate
            else f"已经在 EMA20 {_f(ema20)} 和 MA20 抵扣价 {_f(drop)} 上方，按收盘进")
    stop = min(ema20, next_drop)
    reason = (f"20 线组拐头失败：进场后收盘跌回 {_f(stop)} 下方（EMA20 {_f(ema20)}、进场次日要扣的 {_f(next_drop)} 里较低的），"
              "两条线重新向下")
    return Entry(price, cond + extra_text, rule, far), Stop(stop, reason, "P23", "视频")


def _turn60_stop(c: rl.Ctx) -> Stop:
    """吃回撤的底线：60 线组拐头向下（MA60 看明天的抵扣价、EMA60 看线本身，收盘低于两者中较低的那个两条都向下）。"""
    price = min(_row(c, "EMA60"), _drop(c, 60))
    return Stop(price, f"60 线组拐头向下：收盘低于 {_f(price)}，MA60、EMA60 都向下。视频没给吃回撤的止损价位，放在 60 线组拐头是解读",
                "P23", "解读")


def _ema20_stop(c: rl.Ctx, rule: str, why: str) -> Stop:
    price = _row(c, "EMA20")
    return Stop(price, f"收盘跌破 EMA20 {_f(price)}、EMA20 拐头向下（{why}）", rule, "视频")


def _ambush_stop(c: rl.Ctx, res: rl.Result) -> Stop:
    level = res.levels.get("避免双死叉")
    reason = "20 线组与 60 线组交叉或不可避免要交叉就止损"
    if level is None:
        return Stop(None, reason + f"（{res.basis}，推演给不出价位）", "P3", "视频")
    return Stop(level, reason + f"：{rl.STOP_DAYS} 天内收盘低于 {_f(level)} 就避不开双死叉（价位来自推演求解，辅助，评估 H4）",
                "P3", "视频")


def _breakout_bar(c: rl.Ctx, box_high: float) -> pd.Series | None:
    """横盘突破：最近 BREAKOUT_BARS 根里收盘第一次越过箱体上沿的那根（起涨 K 线），之后收盘一直在上沿之上。"""
    if "Low" not in c.df.columns:
        return None
    recent = c.df.iloc[-rl.BREAKOUT_BARS:]
    above = recent["Close"] > box_high
    if not above.iloc[-1]:
        return None
    first = len(above) - 1
    while first > 0 and above.iloc[first - 1]:
        first -= 1
    if first == 0 and c.df["Close"].iloc[-rl.BREAKOUT_BARS - 1] > box_high:
        return None   # 突破早于这几根，不再是刚突破
    return recent.iloc[first]


def _range_flat(c: rl.Ctx) -> tuple[Entry | None, Stop | None, list[str]]:
    p2, p3 = rl.p2_ambush(c), rl.p3_ambush_stop(c)
    if p2.status == rl.Status.MET:
        return Entry(c.close, "末期三个条件齐了、还没突破箱体：按收盘小仓位埋伏", "P2"), _ambush_stop(c, p3), []
    g = c.regime.range
    late = all(f(c).status == rl.Status.MET for f in (rl.j12_range_long_enough, rl.j13_range_dense, rl.j14_range_opening))
    bar = _breakout_bar(c, g.box_high) if late and g and g.box_high else None
    if bar is not None:
        low = float(bar["Low"])
        return (Entry(c.close, f"末期条件齐了，已突破箱体上沿 {_f(g.box_high)}：突破买入", "P21"),
                Stop(low, f"起涨 K 线（{bar.name.date()} 收盘第一次站上箱体上沿）最低价 {_f(low)}：跌回来多头攻势就失败了",
                     "P22", "视频"),
                ["起涨 K 线取收盘第一次站上箱体上沿的那根，视频是在图上指的（解读）"])
    return Entry(None, "横盘中段不做：末期三个条件（满 6 个月、均线相差 < 2%、向上张嘴）齐了再埋伏", "P1"), None, []


def _pullback_flat(c: rl.Ctx) -> Entry:
    """稳定上涨吃回撤：四个条件里还差哪一步，进场价就按那一步的价位。"""
    p11, p12, p13 = rl.p11_pullback_reach(c), rl.p12_pullback_construct(c), rl.p13_hourly_arrangement(c)
    if rl.p14_pullback_entry(c).status == rl.Status.MET:
        return Entry(c.close, "吃回撤四个条件今天齐了：按收盘进", "P14")
    if p11.status != rl.Status.MET:
        group = p11.levels.get("60 线组")
        if group is not None and c.close > group:
            return Entry(group, f"回撤到 60 线组 {_f(group)}，之后还要底部构造、小时线多头排列", "P11")
        return Entry(None, f"回撤②不满足：{p11.basis}", "P11")
    if p12.status != rl.Status.MET:
        at = p12.levels.get("完成价", p12.levels.get("下一步价"))
        if at is None:
            return Entry(None, "这次回撤后还没有底部构造，等它出现", "P12")
        return Entry(max(at, c.close), f"底部构造完成（最高价越过 {_f(at)}），再加小时线多头排列", "P12")
    if p13.status != rl.Status.MET:
        return Entry(c.close, "日线三个条件齐了，只差小时线多头排列（看小时图）", "P13")
    return Entry(c.close, "吃回撤四个条件齐了", "P14")


def _bottom_turn_flat(c: rl.Ctx) -> tuple[Entry, Stop]:
    """加速下跌：等底部构造（J21）和关键性波动（20 线组拐头向上，J19）再进。"""
    k = rl.j21_bottom_construct(c)
    at = None if k.status == rl.Status.MET else k.levels.get("完成价", k.levels.get("下一步价"))
    text = "" if at is None else f"；先等底部构造完成（最高价越过 {_f(at)}）"
    return _turn20(c, "J19", at, text)


def _hold_double_death(c: rl.Ctx) -> Stop:
    res = solve(c.df, Event(EventKind.DOUBLE_BELOW, 20, 60), HOLD_STOP_DAYS, happen=False)
    reason = "20/60 双死叉才算结构坏"
    if res.status != SolveStatus.LEVEL:
        return Stop(None, reason + f"（{HOLD_STOP_DAYS} 天内避免双死叉：{res.status.value}）", "J16", "视频")
    return Stop(res.level, reason + f"：{HOLD_STOP_DAYS} 天内收盘停在 {_f(res.level)} 以下就会双死叉（价位来自推演求解，辅助，评估 H4）",
                "J16", "视频")


DOWN_KEYS = ("稳定下跌", "加速下跌")
DOWN_NO_STOP = "下跌趋势里下方没有均线托底，止损不靠均线：反弹到 EMA20 一带就是离场点"
DOWN_NO_TARGET = "下跌趋势还没拐头向上，持仓不找目标位：上方的缺口、均线密集是拐头向上以后才当目标的（P25）"


def plan_key(c: rl.Ctx) -> str:
    key = rl.play_key(c.regime)
    if key == "横盘" and rl.p3_ambush_stop(c).status == rl.Status.MET:
        return "横盘破位"
    return key


def _legs(c: rl.Ctx, key: str) -> tuple[Entry | None, Stop | None, Stop | None, list[str]]:
    """(空仓进场, 空仓进场后止损, 持仓止损, 说明)。不买的打法空仓进场为 None。"""
    no_buy = "空仓不进场"
    if key == "横盘":
        entry, stop, notes = _range_flat(c)
        return entry, stop, _ambush_stop(c, rl.p3_ambush_stop(c)), notes
    if key == "横盘破位":
        return (None, None, Stop(c.close, f"埋伏的底线已经破了（{rl.p3_ambush_stop(c).basis}）：现价离场", "P3", "视频"),
                ["底线已破：不埋伏，等多头排列再说"])
    if key == "稳定上涨":
        return _pullback_flat(c), _turn60_stop(c), _turn60_stop(c), []
    if key == "多头结构回撤中":
        entry, stop = _turn20(c, "P19、P20")
        return entry, stop, _hold_double_death(c), []
    if key == "加速下跌":
        entry, stop = _bottom_turn_flat(c)
        return entry, stop, None, []
    if key == "加速上涨":
        return None, None, _ema20_stop(c, "J19", "20 线组拐头向下就是关键性波动"), [f"{no_buy}：加速中不追（P7）"]
    if key == "稳定下跌":
        return None, None, None, [f"{no_buy}：理顺成多头之前不抄底"]
    if key == "空头结构反弹中":
        return None, None, _ema20_stop(c, "P18", "反弹没解除双死叉，转头就走"), [f"{no_buy}：20 线组被压在 60 线组下方（P17）"]
    return None, None, _ema20_stop(c, "P18", "MA、EMA 不协同就减"), [f"{no_buy}：排列没理顺"]


def _plan(c: rl.Ctx, key: str, entry: Entry | None, stop: Stop | None, ref: float | None, sizing: Sizing | None,
          notes: list[str], aim: bool = True) -> TradePlan:
    """ref：算目标和距离的价位（空仓是进场价，持仓是现价）。sizing 为 None（持仓）不算股数、不算盈亏比。
    aim 为 False 时不找目标位（下跌趋势的持仓，说明在 notes 里）。"""
    notes = list(notes)
    targets = find_targets(c.df, c.structure, ref) if ref is not None and aim else []
    mountain = mountain_above(c.profile, ref) if ref is not None else None
    if ref is not None and targets and targets[0].kind == "前高":
        notes.append("上方没有缺口和下跌途中形成的均线密集区，目标用最近的波峰（前高），是解读")
    elif ref is not None and aim and not targets:
        notes.append("上方没有缺口、均线密集区，也没有更高的波峰：目标位算不出")
    s = stop.price if stop else None
    risk_pct = None if ref is None or s is None or s >= ref else (ref - s) / ref * 100
    at_target = at_target_line(key, targets)
    if sizing is None:
        return TradePlan(entry, stop, targets, None, None, None, risk_pct, None, at_target, notes, mountain)
    rr = reward_risk(ref, s, targets[0].price) if ref is not None and s is not None and targets else None
    verdict = rr_verdict(rr)
    gap = None
    if verdict == "不做":
        t1 = targets[0].price
        gap = {"target_for_min": ref + RR_MIN * (ref - s), "stop_for_min": ref - (t1 - ref) / RR_MIN}
    if entry is not None and rr is None and ref is not None and targets and s is not None:
        notes.append("止损不在进场价下方，盈亏比算不了")
    size, why = size_position(ref, s, sizing) if entry is not None else (None, None)
    if why and ref is not None:
        notes.append(why)
    return TradePlan(entry, stop, targets, rr, verdict, gap, risk_pct, size, at_target, notes, mountain)


def build(c: rl.Ctx, sizing: Sizing | None = None) -> PlanSet:
    key = plan_key(c)
    entry, flat_stop, hold_stop, notes = _legs(c, key)
    ref = entry.price if entry else None
    flat = _plan(c, key, entry, flat_stop if entry else None, ref, sizing or Sizing(), notes)
    down = key in DOWN_KEYS
    hold_notes = ([DOWN_NO_STOP, DOWN_NO_TARGET] if down else []) + ["止损按进场的原则给，成本价只用来算仓位"]
    holding = _plan(c, key, None, hold_stop, c.close, None, hold_notes, aim=not down)
    return PlanSet(key, flat, holding)


def verdict_line(p: PlanSet) -> str | None:
    """盈亏比不够 3:1 时写进打法的一句话：差多少。触发价离现价还远时只说到时重算。"""
    f = p.flat
    if f.entry is not None and f.entry.far is not None:
        return f"触发价离现价还远，盈亏比到时重算（P24）：{far_text(f.entry.far, f.entry.price)}。"
    if f.rr_verdict != "不做":
        return None
    t1 = f.targets[0]
    return (f"盈亏比 {f.rr:.2f}:1，不到 3:1，不做（P24）。第一目标 {_f(t1.price)}（{t1.kind}）。"
            f"要 3:1，目标得到 {_f(f.rr_gap['target_for_min'])}，或止损收紧到 {_f(f.rr_gap['stop_for_min'])}。")


def plan_json(p: PlanSet) -> dict:
    return asdict(p)
