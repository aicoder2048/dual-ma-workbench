"""周线：日线重采样后跑同一套指标和排列判断。"""
from __future__ import annotations

import json

import pandas as pd

from conftest import load_fixture
from weekly import to_weekly, weekly_json


def test_resample_takes_week_extremes_and_last_close():
    idx = pd.bdate_range("2024-01-01", periods=8)  # 周一到下周三
    df = pd.DataFrame({"Open": range(1, 9), "High": [5, 9, 6, 7, 8, 3, 4, 2], "Low": [1, 2, 0, 3, 4, 1, 2, 0.5],
                       "Close": [2, 3, 4, 5, 6, 7, 8, 9], "Volume": [10] * 8}, index=idx)
    w = to_weekly(df)
    assert [str(d.date()) for d in w.index] == ["2024-01-05", "2024-01-10"]  # 每周最后一个交易日
    assert w.iloc[0][["Open", "High", "Low", "Close", "Volume"]].tolist() == [1, 9, 0, 6, 50]
    assert w.iloc[1][["Open", "High", "Low", "Close", "Volume"]].tolist() == [6, 4, 0.5, 9, 30]


def test_close_only_csv_still_resamples():
    idx = pd.bdate_range("2024-01-01", periods=6)
    w = to_weekly(pd.DataFrame({"Close": [1.0, 2, 3, 4, 5, 6]}, index=idx))
    assert list(w.columns) == ["Close"] and w["Close"].tolist() == [5, 6]


def test_spy_2024_04_19_weekly_is_bullish():
    out = weekly_json(load_fixture("SPY", "2024-04-19", years=5))
    assert out["available"]
    assert (out["arr_ma"], out["arr_ema"]) == ("多头", "多头")
    assert out["date"] == "2024-04-19" and not out["partial"]


def test_short_history_says_why_weekly_is_missing():
    out = weekly_json(load_fixture("SPY", "2024-04-19", years=1))
    assert out["available"] is False and "MA120" in out["reason"]


def test_weekly_is_json_safe_and_flags_a_partial_week():
    out = weekly_json(load_fixture("TSLA", "2021-04-14", years=5))  # 2021-04-14 是周三
    json.dumps(out, ensure_ascii=False, allow_nan=False)
    assert out["partial"] and [ln["period"] for ln in out["lines"]] == [20, 60, 120]
