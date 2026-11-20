"""小时线：取常规交易时段的 1 小时 K 线，跑同一套均线指标和排列判断，给 P13（吃回撤④）用。

数据源：Polygon 30 分钟线合成小时线（档位约 5 年），取不到再用 yfinance 1h（只有最近约 730 天）。
回放日期超出两边的窗口时，P13 保持"需看图"。只多一次请求，不拖慢日线分析。
"""
from __future__ import annotations

import urllib.parse
from dataclasses import asdict, dataclass
from typing import Callable

import pandas as pd

from indicators import PERIODS, add_indicators, arrangement

LOOKBACK_DAYS = 60            # 自然日：MA120 要 120 根小时线（约 19 个交易日），多取一些给 EMA 预热
MIN_BARS = max(PERIODS) + 1
YF_WINDOW_DAYS = 729          # yfinance 1h 只给最近 730 天
TZ = "America/New_York"
OPEN, CLOSE = pd.Timedelta(hours=9, minutes=30), pd.Timedelta(hours=16)


@dataclass(frozen=True)
class HourlyLine:
    period: int
    ma: float
    ema: float


@dataclass(frozen=True)
class Hourly:
    source: str
    bars: int
    last: str                 # 最后一根小时线的开始时间（美东）
    close: float
    lines: list[HourlyLine]
    arr_ma: str
    arr_ema: str


def regular_hours(bars: pd.DataFrame) -> pd.DataFrame:
    """美东时间索引的分钟级 K 线 → 常规时段（9:30–16:00）的小时线，9:30 起每小时一根，15:30 那根半小时。"""
    since_midnight = bars.index - bars.index.normalize()
    rth = bars[(since_midnight >= OPEN) & (since_midnight < CLOSE)]
    out = rth["Close"].resample("60min", origin="start_day", offset="30min").last().dropna()
    return out.to_frame("Close")


def hourly_json(bars: pd.DataFrame, source: str) -> dict:
    """JSON 里的 hourly 一块。bars 是常规时段小时线（Close 列，美东时间索引）。"""
    if len(bars) < MIN_BARS:
        return {"available": False, "reason": f"小时线只有 {len(bars)} 根，MA{max(PERIODS)} 需要 {MIN_BARS} 根"}
    h = add_indicators(bars[["Close"]].copy())
    now = h.iloc[-1]
    hourly = Hourly(source=source, bars=len(h), last=now.name.strftime("%Y-%m-%d %H:%M"), close=float(now["Close"]),
                    lines=[HourlyLine(period=n, ma=float(now[f"MA{n}"]), ema=float(now[f"EMA{n}"])) for n in PERIODS],
                    arr_ma=arrangement(now, "MA"), arr_ema=arrangement(now, "EMA"))
    return {"available": True, **asdict(hourly)}


def fetch_polygon_30m(ticker: str, start: str, end: str, api_key: str,
                      get_json: Callable[[str], dict]) -> pd.DataFrame:
    url = (f"https://api.polygon.io/v2/aggs/ticker/{urllib.parse.quote(ticker.upper())}/range/30/minute/"
           f"{start}/{end}?adjusted=true&sort=asc&limit=50000&apiKey={api_key}")
    rows = get_json(url).get("results") or []
    if not rows:
        raise RuntimeError("没有小时数据")
    df = pd.DataFrame(rows)
    idx = pd.to_datetime(df["t"], unit="ms", utc=True).dt.tz_convert(TZ).dt.tz_localize(None)
    return pd.DataFrame({"Close": df["c"].to_numpy()}, index=pd.DatetimeIndex(idx))


def fetch_yfinance_1h(ticker: str, start: str, end: str) -> pd.DataFrame:
    import yfinance as yf

    end_excl = (pd.Timestamp(end) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    df = yf.download(ticker, start=start, end=end_excl, interval="1h", auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if df.empty:
        raise RuntimeError("没有小时数据")
    idx = df.index.tz_convert(TZ).tz_localize(None) if df.index.tz is not None else df.index
    return pd.DataFrame({"Close": df["Close"].to_numpy()}, index=idx)


def load_hourly(ticker: str, asof: str | None, api_key: str | None, source: str,
                get_json: Callable[[str], dict], today: pd.Timestamp | None = None) -> dict:
    """先 Polygon 再 yfinance；都取不到时返回 {"available": False, "reason": ...}，P13 保持需看图。"""
    today = today or pd.Timestamp.today().normalize()
    end_ts = pd.Timestamp(asof) if asof else today
    start, end = (end_ts - pd.Timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d"), end_ts.strftime("%Y-%m-%d")
    notes = []
    if source in ("auto", "polygon"):
        if not api_key:
            notes.append("Polygon：没找到 POLYGON_API_KEY")
        else:
            try:
                return hourly_json(regular_hours(fetch_polygon_30m(ticker, start, end, api_key, get_json)),
                                   "Polygon/Massive（30 分钟线合成）")
            except Exception as exc:  # 档位、网络都退回 yfinance
                notes.append(f"Polygon：{str(exc).split('.')[0]}")
    if source in ("auto", "yfinance"):
        if (today - end_ts).days > YF_WINDOW_DAYS:
            notes.append(f"yfinance：小时线只有最近约 {YF_WINDOW_DAYS + 1} 天")
        else:
            try:
                return hourly_json(fetch_yfinance_1h(ticker, start, end), "yfinance（1h）")
            except Exception as exc:
                notes.append(f"yfinance：{exc}")
    return {"available": False, "reason": "；".join(notes) or "没有可用的数据源"}
