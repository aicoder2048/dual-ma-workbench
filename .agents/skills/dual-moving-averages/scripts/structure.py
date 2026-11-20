"""顶底构造与波段，定义来自 videoes/頂底構造.vtt，只看每根 K 线的最高价和最低价。

顶部构造：新高那根 K 线之后，先出现一根不被它包住、最高价没超过它的 K 线（更低的高点），
再出现一根最低价更低的 K 线（更低的低点），最少三根。
- 包含结构：最高、最低都在新高那根 K 线范围内的 K 线忽略。
- 极端构造：第二根创新高、同时跌破前一根的低点，仍要第三根跌破它的低点来确认。
- 破坏：完成之后、底部构造出现之前，又创出更高的高点，构造作废，从新高点重新找。
底部构造是镜像：把 (最高, 最低) 换成 (−最低, −最高)，用同一段代码找。

顶部、底部构造交替出现，两个构造不共用 K 线；没被破坏的构造按顺序就是波段的端点。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum

import pandas as pd

TWO_B_BARS = 5        # 2B："迅速"跌回 A 之下，取 C 之后 5 根 K 线内
KEEP_PIVOTS = 10      # JSON 里保留最近几个波段端点
KEEP_PATTERNS = 5


class Side(str, Enum):
    TOP = "顶部构造"
    BOTTOM = "底部构造"


class State(str, Enum):
    FORMING = "形成中"
    DONE = "已完成"
    BROKEN = "已破坏"


@dataclass(frozen=True)
class Construct:
    side: Side
    state: State
    extreme: bool               # 极端构造
    pivot_date: str             # 新高（新低）那根 K 线
    pivot_price: float          # 它的最高价（最低价）
    lh_date: str | None         # 更低的高点（更高的低点）那根
    done_date: str | None       # 完成构造的那根
    broken_date: str | None
    invalidation: float         # 作废价位：之后最高价超过它（底部：最低价跌破它）构造作废
    complete_at: float | None   # 形成中且只差一根时：下一根最低价低于它（底部：最高价高于它）就完成
    next_at: float | None       # 形成中：下一根最低价低于它（底部：最高价高于它）就往前走一步
    bars_left: int | None       # 形成中：最少还要几根 K 线才完成（1 或 2）


@dataclass(frozen=True)
class Pivot:
    kind: str                   # 高 / 低
    date: str
    price: float


@dataclass(frozen=True)
class Pattern:
    name: str                   # M 顶 / W 底 / 2B 顶 / 2B 底
    state: str                  # 已形成 / 待确认
    dates: list[str]            # 构成它的几个构造的新高（新低）日期
    level: float                # M/W：颈线；2B：前高 A（前低 A）


@dataclass(frozen=True)
class Structure:
    constructs: list[Construct]  # 完成过的（含已破坏），按时间
    top: Construct | None        # 最近的顶部构造（可能还在形成中）
    bottom: Construct | None
    pivots: list[Pivot]          # 波段端点，高低交替
    last_high: Pivot | None
    last_low: Pivot | None
    patterns: list[Pattern]


@dataclass
class _Seek:
    """在"顶部朝向"的 (hi, lo) 上找一个顶部构造。"""
    pivot: int
    lh: int | None = None
    extreme: bool = False

    def step(self, i: int, hi: list[float], lo: list[float]) -> bool:
        """喂一根 K 线，完成构造时返回 True。"""
        if hi[i] > hi[self.pivot]:
            self.extreme = lo[i] < lo[self.pivot]
            self.pivot, self.lh = i, None
            return False
        ref = self.lh if self.lh is not None else (self.pivot if self.extreme else None)
        if ref is not None and lo[i] < lo[ref]:
            return True
        if self.lh is None and lo[i] < lo[self.pivot]:
            self.lh = i
        return False


@dataclass
class _Record:
    side: Side
    seek: _Seek
    pivot: int
    lh: int | None
    extreme: bool
    price: float                # 新高（新低）那根的最高价（最低价），原始价格
    done: int
    broken: int | None = None


def _other(side: Side) -> Side:
    return Side.BOTTOM if side == Side.TOP else Side.TOP


def _scan(high: list[float], low: list[float]) -> tuple[list[_Record], dict[Side, _Seek | None]]:
    oriented = {Side.TOP: (high, low), Side.BOTTOM: ([-x for x in low], [-x for x in high])}
    records: list[_Record] = []
    seeks: dict[Side, _Seek | None] = {Side.TOP: _Seek(0), Side.BOTTOM: _Seek(0)}
    pending: _Record | None = None   # 最近完成、反向构造还没出现的那个，还可能被破坏
    for i in range(1, len(high)):
        if pending is not None:
            hi, _ = oriented[pending.side]
            if hi[i] > hi[pending.pivot]:
                pending.broken = i
                seeks = {pending.side: pending.seek}   # 接着从新高点找
                pending = None
        for side, seek in list(seeks.items()):
            if seek is None:
                seeks[side] = _Seek(i)
            elif seek.step(i, *oriented[side]):
                price = high[seek.pivot] if side == Side.TOP else low[seek.pivot]
                pending = _Record(side, seek, seek.pivot, seek.lh, seek.extreme, price, done=i)
                records.append(pending)
                seeks = {_other(side): None}          # 反向构造从下一根起找
                break
    return records, seeks


def find_structure(df: pd.DataFrame) -> Structure | None:
    """没有最高价、最低价时返回 None。"""
    if not {"High", "Low"} <= set(df.columns):
        return None
    df = df.dropna(subset=["High", "Low"])
    if df.empty:
        return None
    high, low = df["High"].astype(float).tolist(), df["Low"].astype(float).tolist()
    close = df["Close"].astype(float).tolist()
    dates = [str(d.date()) for d in df.index]
    records, seeks = _scan(high, low)

    def price(side: Side, i: int, top_col: list[float], bottom_col: list[float]) -> float:
        return top_col[i] if side == Side.TOP else bottom_col[i]

    def construct(r: _Record) -> Construct:
        return Construct(side=r.side, state=State.BROKEN if r.broken is not None else State.DONE,
                         extreme=r.extreme, pivot_date=dates[r.pivot], pivot_price=r.price,
                         lh_date=None if r.lh is None else dates[r.lh], done_date=dates[r.done],
                         broken_date=None if r.broken is None else dates[r.broken],
                         invalidation=r.price, complete_at=None, next_at=None, bars_left=None)

    def forming(side: Side, s: _Seek) -> Construct:
        ref = s.lh if s.lh is not None else (s.pivot if s.extreme else None)
        # 还没有更低的高点（更高的低点）：下一根先越过新高（新低）那根的低点（高点）成为它，再要一根越过它才完成
        step = s.pivot if ref is None else ref
        return Construct(side=side, state=State.FORMING, extreme=s.extreme, pivot_date=dates[s.pivot],
                         pivot_price=price(side, s.pivot, high, low),
                         lh_date=None if s.lh is None else dates[s.lh], done_date=None, broken_date=None,
                         invalidation=price(side, s.pivot, high, low),
                         complete_at=None if ref is None else price(side, ref, low, high),
                         next_at=price(side, step, low, high), bars_left=2 if ref is None else 1)

    done = [construct(r) for r in records]
    latest = {side: next((c for c in reversed(done) if c.side == side), None) for side in Side}
    for side, s in seeks.items():
        if s is not None:
            latest[side] = forming(side, s)
    kept = [r for r in records if r.broken is None]
    pivots = [Pivot("高" if r.side == Side.TOP else "低", dates[r.pivot], r.price) for r in kept]
    return Structure(constructs=done, top=latest[Side.TOP], bottom=latest[Side.BOTTOM], pivots=pivots,
                     last_high=next((p for p in reversed(pivots) if p.kind == "高"), None),
                     last_low=next((p for p in reversed(pivots) if p.kind == "低"), None),
                     patterns=_patterns(records, kept, close, dates))


def _beyond(side: Side, value: float, level: float) -> bool:
    """收盘越过 level：顶部一侧是跌破，底部一侧是升破。"""
    return value < level if side == Side.TOP else value > level


def _patterns(records: list[_Record], kept: list[_Record], close: list[float], dates: list[str]) -> list[Pattern]:
    found: list[tuple[int, Pattern]] = []
    # M 顶：顶、底、顶，之后（下一个端点完成前）收盘跌破中间那个底（颈线）。W 底镜像。
    for j in range(len(kept) - 2):
        a, b, c = kept[j:j + 3]
        nxt = kept[j + 3] if j + 3 < len(kept) else None
        neck = b.price
        window = close[c.pivot + 1:(nxt.done + 1) if nxt else len(close)]
        name = "M 顶" if a.side == Side.TOP else "W 底"
        when = [dates[r.pivot] for r in (a, b, c)]
        if any(_beyond(a.side, v, neck) for v in window):
            found.append((c.pivot, Pattern(name, "已形成", when, neck)))
        elif nxt is None:
            found.append((c.pivot, Pattern(name, "待确认", when, neck)))
    # 2B：构造 A 被新高 C 破坏（中间没有反向构造），C 之后几根内收盘又跌回 A 之下。
    for r, nxt in zip(records, records[1:]):
        if r.broken is None:
            continue
        window = close[nxt.pivot + 1:nxt.pivot + 1 + TWO_B_BARS]
        if any(_beyond(r.side, v, r.price) for v in window):
            name = "2B 顶" if r.side == Side.TOP else "2B 底"
            found.append((nxt.pivot, Pattern(name, "已形成", [dates[r.pivot], dates[nxt.pivot]], r.price)))
    return [p for _, p in sorted(found, key=lambda t: t[0])]


def structure_json(df: pd.DataFrame) -> dict:
    """JSON 里的 structure 一块；没有最高价、最低价（例如只有收盘价的 CSV）时只说无数据。"""
    s = find_structure(df)
    if s is None:
        return {"available": False, "reason": "无数据"}
    out = asdict(s)
    del out["constructs"]
    out["pivots"] = out["pivots"][-KEEP_PIVOTS:]
    out["patterns"] = out["patterns"][-KEEP_PATTERNS:]
    return {"available": True, **out}
