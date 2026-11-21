"""筹码分布（视频 O）：把一段 K 线的成交量按价格分档统计，找出筹码山和它的山脚、山顶。规则 J45–J49、P38、P39。

- 分档：统计区间的最低价到最高价等分成 PROFILE_BINS 档。
- 分配：每根 K 线的量按价格均匀摊在它的 [最低价, 最高价] 上，每档分到的量和它与这根 K 线重叠的长度成正比；
  一字线（最高 = 最低）整根的量记在它所在那档。
- 筹码山：量 ≥ PROFILE_EDGE × 各档平均量的连续几档。山脚是最下面那档的下沿，山顶是最上面那档的上沿（J46），
  不是量最大的那一档（POC）。
- 统计区间：图上是可见的那段 K 线（推断，见 J45），工作台在浏览器里用 app/public/volprofile.js 算，
  算法和这里一行对一行，test_volprofile.py 和 app/test/volprofile.test.ts 用同一份夹具互相核对。
  交易计划没有"可见范围"，固定用最近 PROFILE_DAYS 个自然日，和图默认的「1 年」视图同一段。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from math import floor

import pandas as pd

PROFILE_BINS = 24      # 脚本自定：分 24 档，TradingView 成交量分布（视频 O 用的 Visible Range Volume Profile）的默认行数
PROFILE_EDGE = 1.0     # 脚本自定：一档的量 ≥ 各档平均量的 1 倍算在山里，低于平均就出了山（J46），看回测之前定的
PROFILE_DAYS = 365     # 脚本自定：交易计划的统计区间是最近 365 个自然日，和工作台日线默认的「1 年」视图一样


@dataclass(frozen=True)
class Mountain:
    foot: float            # 山脚：价格下沿
    top: float             # 山顶：价格上沿
    volume: float          # 这座山几档的量加起来
    share: float           # 占统计区间总量的比例


@dataclass(frozen=True)
class Profile:
    start: str             # 统计区间第一根、最后一根 K 线的日期
    end: str
    bars: int
    edges: list[float]     # PROFILE_BINS + 1 个档位边界，从低到高
    volumes: list[float]   # 每档的量
    mountains: list[Mountain]   # 从低到高

    def above(self, price: float) -> list[Mountain]:
        """整座在价格上方的山（山脚 > 价格），近的在前。"""
        return [m for m in self.mountains if m.foot > price]

    def below(self, price: float) -> list[Mountain]:
        """整座在价格下方的山（山顶 < 价格），近的在前。"""
        return [m for m in reversed(self.mountains) if m.top < price]

    def containing(self, price: float) -> Mountain | None:
        return next((m for m in self.mountains if m.foot <= price <= m.top), None)

    def largest(self) -> Mountain | None:
        """量最大的那座山（J48 的"最高峯"按它读，推断）。"""
        return max(self.mountains, key=lambda m: m.volume, default=None)


def distribute(highs: list[float], lows: list[float], volumes: list[float],
               bins: int = PROFILE_BINS) -> tuple[list[float], list[float]]:
    """(档位边界, 每档的量)。运算顺序和 volprofile.js 的 distribute 一样，两边结果逐位相同。"""
    lo, hi = min(lows), max(highs)
    edges = [lo + (hi - lo) * j / bins for j in range(bins + 1)]
    out = [0.0] * bins
    if hi <= lo:
        return edges, out
    width = (hi - lo) / bins
    for h, l, v in zip(highs, lows, volumes):
        if h <= l:
            out[min(floor((l - lo) / width), bins - 1)] += v
            continue
        for j in range(bins):
            overlap = min(h, edges[j + 1]) - max(l, edges[j])
            if overlap > 0:
                out[j] += v * overlap / (h - l)
    return edges, out


def _add(xs: list[float]) -> float:
    """从左往右逐个加。sum() 在 Python 3.12 起做补偿求和，和 JS 的结果会差最后一位。"""
    total = 0.0
    for x in xs:
        total += x
    return total


def find_mountains(edges: list[float], volumes: list[float], edge: float = PROFILE_EDGE) -> list[Mountain]:
    """量 ≥ edge × 各档平均量的连续几档是一座山。"""
    total = _add(volumes)
    if total <= 0:
        return []
    line = edge * total / len(volumes)
    out, start = [], None
    for j, v in enumerate([*volumes, -1.0]):
        if v >= line and start is None:
            start = j
        elif v < line and start is not None:
            vol = _add(volumes[start:j])
            out.append(Mountain(edges[start], edges[j], vol, vol / total))
            start = None
    return out


def profile_window(df: pd.DataFrame, days: int = PROFILE_DAYS) -> pd.DataFrame:
    """交易计划的统计区间：最后一根往前 days 个自然日以内的 K 线（含最后一根），量缺的那几根不算。"""
    w = df[df.index >= df.index[-1] - pd.Timedelta(days=days)]
    return w.dropna(subset=["High", "Low", "Volume"])


def volume_profile(df: pd.DataFrame) -> Profile | None:
    """df 里全部 K 线的筹码分布；没有最高价、最低价或成交量时为 None。"""
    if not {"High", "Low", "Volume"} <= set(df.columns):
        return None
    df = df.dropna(subset=["High", "Low", "Volume"])
    if df.empty:
        return None
    edges, vols = distribute(df["High"].astype(float).tolist(), df["Low"].astype(float).tolist(),
                             df["Volume"].astype(float).tolist())
    return Profile(str(df.index[0].date()), str(df.index[-1].date()), len(df), edges, vols, find_mountains(edges, vols))


def plan_profile(df: pd.DataFrame) -> Profile | None:
    """交易计划、规则 J45–J49 用的那份：最近 PROFILE_DAYS 天。"""
    if not {"High", "Low", "Volume"} <= set(df.columns):
        return None
    return volume_profile(profile_window(df))


def profile_json(p: Profile | None) -> dict:
    if p is None:
        return {"available": False, "reason": "数据里没有最高价、最低价或成交量"}
    return {"available": True, "days": PROFILE_DAYS, **asdict(p)}
