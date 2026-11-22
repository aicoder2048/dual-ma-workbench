"""类型 × 阶段、钟表校准、五步进度。基准来自 IMPLEMENTATION_PLAN 0.6 的"改造后应该是"一列。"""
from __future__ import annotations

import pandas as pd
import pytest

from conftest import load_fixture
import dma_analyze as dma
from indicators import add_indicators


def regime_of(ticker: str, asof: str) -> dict:
    return dma.analyze(load_fixture(ticker, asof), ticker, "fixture")["regime"]


def synthetic(closes: list[float]) -> dict:
    df = add_indicators(pd.DataFrame({"Close": closes}, index=pd.bdate_range("2020-01-02", periods=len(closes))))
    return dma.analyze(df, "T", "synthetic")["regime"]


# ---------- 0.6 的五个基准日期 ----------

def test_spy_2024_04_19_is_steady_up_pulling_back():
    r = regime_of("SPY", "2024-04-19")
    assert (r["type"], r["stage"]) == ("稳定上涨", "回撤中")


def test_spy_2024_04_19_below_the_60_group_keeps_type_and_stage():
    # 稳定上涨回撤到 60 线组下方：类型不变，阶段是回撤中
    df = load_fixture("SPY", "2024-04-19")
    row = df.iloc[-1]
    assert row["Close"] < min(row["MA60"], row["EMA60"])
    r = regime_of("SPY", "2024-04-19")
    assert (r["type"], r["stage"], r["depth"]) == ("稳定上涨", "回撤中", "跌破 60 线组")


def test_spy_2024_08_05_is_a_deep_pullback_through_the_120_group():
    r = regime_of("SPY", "2024-08-05")
    assert (r["type"], r["stage"], r["depth"]) == ("稳定上涨", "回撤中", "击穿 120 线组")


def test_tsla_2021_04_14_is_a_bear_structure_bouncing():
    r = regime_of("TSLA", "2021-04-14")
    assert r["type"] is None
    assert r["name"] == "空头结构反弹中"


def test_tsla_2021_03_04_classifies_without_error():
    # 0.6 只给了这天的求解数字，没给分类；这里只钉住"60/120 还在多头，20 线组回撤"
    r = regime_of("TSLA", "2021-03-04")
    assert (r["type"], r["stage"]) == ("稳定上涨", "回撤中")


def test_googl_2025_04_08_is_accelerating_down():
    r = regime_of("GOOGL", "2025-04-08")
    assert r["type"] == "加速下跌"
    assert r["accel"]["phase"] == "起点"


# ---------- 钟表校准（rules.md 文末） ----------

@pytest.mark.parametrize(("ticker", "asof", "hour", "lo", "hi"), [
    ("GOOGL", "2021-04-14", "2 点钟", 25, 35),
    ("AAPL", "2021-04-14", "3 点钟", -15, 15),
    ("TSLA", "2020-08-31", "1 点钟", 60, 90),
])
def test_clock_calibration_cases(ticker, asof, hour, lo, hi):
    r = regime_of(ticker, asof)
    assert lo <= r["clock60"]["angle"] <= hi
    assert r["clock60"]["hour"] == hour


def test_calibration_cases_classify_as_the_video_says():
    assert regime_of("GOOGL", "2021-04-14")["type"] == "稳定上涨"
    assert regime_of("AAPL", "2021-04-14")["type"] == "横盘"
    assert regime_of("TSLA", "2020-08-31")["type"] == "加速上涨"


def test_aapl_range_has_a_box_from_swing_pivots():
    g = regime_of("AAPL", "2021-04-14")["range"]
    assert g["box_low"] < g["box_high"]
    assert g["days"] > 0 and not g["dense"]


# ---------- 合成序列 ----------

def test_synthetic_rise_is_steady_up():
    assert synthetic([100 * 1.002 ** i for i in range(300)])["type"] == "稳定上涨"


def test_synthetic_fall_is_steady_down():
    assert synthetic([100 * 0.998 ** i for i in range(300)])["type"] == "稳定下跌"


def test_synthetic_flat_is_range():
    r = synthetic([100 + (1 if i % 2 else -1) for i in range(300)])
    assert r["type"] == "横盘"
    assert r["range"]["dense"]


# ---------- 五步进度 ----------

def test_tsla_2021_turn_dates_match_the_cross_table():
    # memo/模糊正确.md 的交叉表：20/60 MA 死叉 3/05，EMA 死叉 3/08
    steps = dma.analyze(load_fixture("TSLA", "2021-03-31"), "TSLA", "fixture")["steps"]
    p20 = next(p for p in steps if p["pair"] == "20/60")
    got = {s["step"]: s["date"] for s in p20["completed"]["steps"]}
    assert p20["completed"]["direction"] == "向下"
    assert got["第一个交叉"] == "2021-03-05"
    assert got["双交叉"] == "2021-03-08"
    assert got["破线"] <= got["第一个交叉"] and got["MA 拐头"] <= got["第一个交叉"]


def test_tsla_2021_04_14_bounce_is_three_steps_into_an_up_turn():
    steps = dma.analyze(load_fixture("TSLA", "2021-04-14"), "TSLA", "fixture")["steps"]
    p20 = next(p for p in steps if p["pair"] == "20/60")
    assert p20["side"] == "空头"
    assert (p20["current"]["direction"], p20["current"]["progress"]) == ("向上", 3)


def test_range_play_says_weekly_direction_is_not_backed_by_the_evaluation():
    # J11 带了"回测不支持"标签（评估 H5），打法文字也要照说，不能只在标签上标
    a = dma.analyze(load_fixture("AAPL", "2021-04-14"), "AAPL", "fixture")
    text = a["play"]["text"]
    assert "跟周线走" in text and "回测不支持" in text


# ---------- 20/60 已交叉：稳定类型里仍叫回撤中 / 反弹中，是深回撤 / 深反弹（J7） ----------

def test_steady_up_with_20_60_crossed_is_flagged_deep():
    r = regime_of("SPY", "2022-01-25")
    assert (r["type"], r["stage"], r["crossed"]) == ("稳定上涨", "回撤中", True)


def test_steady_down_with_20_60_crossed_is_flagged_deep():
    r = regime_of("TSLA", "2019-07-12")
    assert (r["type"], r["stage"], r["crossed"]) == ("稳定下跌", "反弹中", True)


def test_ordinary_pullback_is_not_flagged_deep():
    r = regime_of("SPY", "2024-04-19")
    assert (r["stage"], r["crossed"]) == ("回撤中", False)
