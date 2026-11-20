"""小时线：常规时段合成、排列判断、P13 的三种状态、取不到时的回退（不联网）。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from conftest import load_fixture
import dma_analyze as dma
import hourly as hr


def thirty_minute_bars(days: int, slope: float) -> pd.DataFrame:
    """每天 4:00–20:00 的 30 分钟线（含盘前盘后），收盘价按 bar 序号线性变化。"""
    stamps = [d + pd.Timedelta(minutes=30 * k) for d in pd.bdate_range("2024-03-01", periods=days) for k in range(8, 40)]
    idx = pd.DatetimeIndex(stamps)
    return pd.DataFrame({"Close": 100 + slope * np.arange(len(idx))}, index=idx)


def test_regular_hours_keeps_930_to_1600_and_starts_bars_at_half_past():
    h = hr.regular_hours(thirty_minute_bars(2, 1.0))
    day = h[h.index.normalize() == pd.Timestamp("2024-03-01")]
    assert [t.strftime("%H:%M") for t in day.index] == ["09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30"]
    assert day["Close"].iloc[-1] == pytest.approx(100 + 23)   # 15:30–16:00 那根的收盘（当天第 24 根），不含盘后


@pytest.mark.parametrize(("slope", "arr"), [(0.1, "多头"), (-0.1, "空头")])
def test_hourly_json_reports_the_arrangement(slope, arr):
    out = hr.hourly_json(hr.regular_hours(thirty_minute_bars(40, slope)), "test")
    assert out["available"] and (out["arr_ma"], out["arr_ema"]) == (arr, arr)
    assert out["bars"] == 40 * 7


def test_too_few_hourly_bars_is_unavailable():
    out = hr.hourly_json(hr.regular_hours(thirty_minute_bars(3, 0.1)), "test")
    assert not out["available"] and "MA120" in out["reason"]


def test_replay_older_than_both_windows_needs_the_chart():
    def refuse(url: str) -> dict:
        raise RuntimeError("HTTP 403 Your plan doesn't include this data timeframe")

    out = hr.load_hourly("TSLA", "2021-04-14", "key", "auto", refuse, today=pd.Timestamp("2026-11-20"))
    assert not out["available"]
    assert "Polygon：HTTP 403" in out["reason"] and "yfinance" in out["reason"]


def test_polygon_bars_are_converted_to_eastern_time_and_used():
    bars = thirty_minute_bars(40, 0.1)
    utc_ms = (bars.index.tz_localize(hr.TZ) - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(milliseconds=1)
    payload = {"results": [{"t": int(t), "c": float(c)} for t, c in zip(utc_ms, bars["Close"])]}
    out = hr.load_hourly("SPY", "2024-04-25", "key", "polygon", lambda url: payload)
    assert out["available"] and out["arr_ma"] == "多头" and out["last"].endswith("15:30")


def hourly_stub(arr: str) -> dict:
    return {"available": True, "source": "test", "bars": 200, "last": "2024-04-19 15:30", "close": 495.0,
            "lines": [{"period": n, "ma": 500.0, "ema": 500.0} for n in (20, 60, 120)], "arr_ma": arr, "arr_ema": arr}


def rule(a: dict, rid: str) -> dict:
    return next(r for r in a["rules"] if r["id"] == rid)


@pytest.mark.parametrize(("hourly", "p13", "p14"), [
    (None, "需看图", "不满足"),
    (hourly_stub("多头"), "满足", "不满足"),
    (hourly_stub("空头"), "不满足", "不满足"),
])
def test_spy_p13_follows_the_hourly_arrangement(hourly, p13, p14):
    # SPY 2024-04-19：吃回撤③ 底部构造没出现，所以 P14 不管小时线怎样都不满足
    a = dma.analyze(load_fixture("SPY", "2024-04-19"), "SPY", "fixture", hourly=hourly)
    assert (rule(a, "P13")["status"], rule(a, "P14")["status"]) == (p13, p14)
    assert "④ " + p13 in rule(a, "P14")["basis"]
    assert f"④ {p13}（P13）" in a["play"]["text"]
