"""周线：日线重采样成周线，跑同一套均线指标和排列判断。"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd

from indicators import PERIODS, add_indicators, arrangement

AGG = {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
MIN_WEEKS = max(PERIODS) + 1      # MA120 要 120 周，再多一周看方向


@dataclass(frozen=True)
class WeeklyLine:
    period: int
    ma: float
    ema: float
    above: bool                   # 周收盘在 MA 上方
    ma_direction: str             # 比上一周：上 / 下 / 平
    ema_direction: str


@dataclass(frozen=True)
class Weekly:
    bars: int
    date: str                     # 最后一周的最后一个交易日
    partial: bool                 # 最后一周还没走完（最后一根日线不是周五）
    close: float
    lines: list[WeeklyLine]
    arr_ma: str
    arr_ema: str


def to_weekly(df: pd.DataFrame) -> pd.DataFrame:
    """按周五结束的自然周聚合，索引用每周实际的最后一个交易日。"""
    agg = {col: how for col, how in AGG.items() if col in df.columns}
    out = df.resample("W-FRI").agg(agg)
    out.index = df.index.to_series().resample("W-FRI").last()
    return out.dropna(subset=["Close"])


def weekly_frame(df: pd.DataFrame) -> pd.DataFrame:
    """周 K 线加上同一套均线指标：周线判断和工作台的周线图都用它。"""
    return add_indicators(to_weekly(df[[c for c in AGG if c in df.columns]]))


def partial_week(df: pd.DataFrame) -> bool:
    """最后一周还没走完：最后一根日线不是周五。"""
    return df.index[-1].weekday() != 4


def _direction(now: float, prev: float) -> str:
    return "上" if now > prev else ("下" if now < prev else "平")


def weekly_json(df: pd.DataFrame) -> dict:
    """JSON 里的 weekly 一块。历史不够 MIN_WEEKS 周时说明原因。"""
    w = weekly_frame(df)
    if len(w) < MIN_WEEKS:
        return {"available": False, "reason": f"周线只有 {len(w)} 根，MA{max(PERIODS)} 需要 {MIN_WEEKS} 根"}
    now, prev = w.iloc[-1], w.iloc[-2]
    lines = [WeeklyLine(period=n, ma=float(now[f"MA{n}"]), ema=float(now[f"EMA{n}"]),
                        above=bool(now["Close"] > now[f"MA{n}"]),
                        ma_direction=_direction(now[f"MA{n}"], prev[f"MA{n}"]),
                        ema_direction=_direction(now[f"EMA{n}"], prev[f"EMA{n}"])) for n in PERIODS]
    weekly = Weekly(bars=len(w), date=str(w.index[-1].date()), partial=partial_week(df),
                    close=float(now["Close"]), lines=lines,
                    arr_ma=arrangement(now, "MA"), arr_ema=arrangement(now, "EMA"))
    return {"available": True, **asdict(weekly)}
