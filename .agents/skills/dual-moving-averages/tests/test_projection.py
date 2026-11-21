"""推演与求解：门槛路径、情景引擎、持平价位求解。真实数字来自 IMPLEMENTATION_PLAN 0.6。"""
from __future__ import annotations

import json
import random

import pandas as pd
import pytest

from conftest import load_fixture
import dma_analyze as dma
from indicators import add_indicators
from projection import Event, EventKind, SolveStatus, hurdle_path, occurs, projection, run_scenario, solve


def random_walk(n: int = 300, seed: int = 7) -> pd.DataFrame:
    rng = random.Random(seed)
    closes, c = [], 100.0
    for _ in range(n):
        c *= 1 + rng.uniform(-0.03, 0.03)
        closes.append(c)
    return add_indicators(pd.DataFrame({"Close": closes}, index=pd.bdate_range("2023-01-02", periods=n)))


# ---------- 门槛路径 ----------

@pytest.mark.parametrize(("n", "days"), [(20, 20), (60, 30), (120, 30)])
def test_hurdle_path_matches_brute_force(n, days):
    df = random_walk()
    h = hurdle_path(df, n, days)
    close = df["Close"].tolist()
    # 第 k 天把 close[-n + k - 1] 扣出窗口
    brute = [close[len(close) - n + k - 1] for k in range(1, days + 1)]
    assert h.prices == pytest.approx(brute)
    assert (h.max_price, h.max_day) == (max(brute), brute.index(max(brute)) + 1)
    assert (h.min_price, h.min_day) == (min(brute), brute.index(min(brute)) + 1)
    assert h.dates[0] == str(df.index[-n].date())


def test_spy_2024_04_19_ma120_hurdle_peaks_below_price():
    df = load_fixture("SPY", "2024-04-19")
    h = hurdle_path(df, 120, 30)
    assert h.max_price == pytest.approx(460.20, abs=0.05)
    assert h.max_price / df["Close"].iloc[-1] - 1 == pytest.approx(-0.071, abs=0.001)


def test_spy_2024_08_05_ma120_hurdle_rises_above_price_on_day_27():
    df = load_fixture("SPY", "2024-08-05")
    h = hurdle_path(df, 120, 30)
    assert h.prices[0] == pytest.approx(494.08, abs=0.05)
    assert (round(h.max_price, 2), h.max_day) == (pytest.approx(522.20, abs=0.05), 27)


# ---------- 情景引擎 ----------

def test_flat_scenario_ma_matches_drop_off_projection():
    df = random_walk()
    c = float(df["Close"].iloc[-1])
    sc = run_scenario(df, c, dma.PROJECT_DAYS)
    for n in dma.PERIODS:
        expected = df[f"MA{n}"].iloc[-1] * (1 + dma.drop_off(df, n)["ma_flat_change_pct"] / 100)
        assert sc.end_values[f"MA{n}"] == pytest.approx(expected), n


def test_flat_scenario_ema_matches_closed_form():
    df = random_walk()
    c = float(df["Close"].iloc[-1])
    sc = run_scenario(df, c, dma.PROJECT_DAYS)
    for n in dma.PERIODS:
        expected = c + (df[f"EMA{n}"].iloc[-1] - c) * (1 - 2 / (n + 1)) ** dma.PROJECT_DAYS
        assert sc.end_values[f"EMA{n}"] == pytest.approx(expected), n


def test_flat_scenario_turn_day_is_first_drop_off_below_level():
    # TSLA 2021-04-14：MA60 在下行，持平时要等抵扣价第一次低于现价（约第 24 天）才拐头向上
    df = load_fixture("TSLA", "2021-04-14")
    sc = run_scenario(df, float(df["Close"].iloc[-1]), 30)
    ma60 = next(t for t in sc.turns if t.line == "MA60")
    assert (ma60.now, ma60.turn_day) == ("下", 24)


def test_scenario_reports_crosses_per_kind():
    df = load_fixture("TSLA", "2021-04-14")
    sc = run_scenario(df, float(df["Close"].iloc[-1]), 30)
    assert {(x.kind, x.pair) for x in sc.crosses} == {(k, p) for k in ("MA", "EMA") for p in ("20/60", "60/120")}
    assert sc.end_arr_ma in ("多头", "空头", "混乱")


# ---------- 求解 ----------

def test_tsla_2021_03_04_death_cross_is_unavoidable():
    df = load_fixture("TSLA", "2021-03-04")
    r = solve(df, Event(EventKind.BELOW, 20, 60, line="MA"), days=2, happen=False)
    assert r.status == SolveStatus.LEVEL
    assert r.level == pytest.approx(285.87, abs=0.3)
    assert r.pct > 30
    # 实际第二天（3/05）就死叉了
    full = load_fixture("TSLA", "2021-03-05")
    assert full["MA20"].iloc[-1] < full["MA60"].iloc[-1] and df["MA20"].iloc[-1] > df["MA60"].iloc[-1]


@pytest.mark.parametrize(("days", "level"), [(10, 246.81), (20, 231.14)])
def test_tsla_2021_04_14_double_cross_levels(days, level):
    df = load_fixture("TSLA", "2021-04-14")
    r = solve(df, Event(EventKind.DOUBLE_ABOVE, 20, 60), days=days)
    assert r.level == pytest.approx(level, abs=0.3)
    assert r.side == "以上"


@pytest.mark.parametrize("event", [Event(EventKind.DOUBLE_ABOVE, 20, 60), Event(EventKind.ALIGN_UP, 20, 60),
                                   Event(EventKind.TURN_UP, 60)])
def test_solved_level_makes_the_event_just_hold(event):
    df = load_fixture("TSLA", "2021-04-14")
    r = solve(df, event, days=10)
    assert occurs(df, event, r.level, 10)
    assert not occurs(df, event, r.level * (1 - 1e-4), 10)


def test_group_turn_up_needs_ma20_and_ema20_up_on_the_same_day():
    """收盘持平在 L：EMA20 在 L 高于今天的 EMA20 时天天向上，MA20 在扣掉的收盘价低于 L 的那天向上。
    两条同一天向上的最低价位 = max(EMA20, 前 10 天里最低的抵扣价)。"""
    closes = [100.0] * 200 + [120, 121, 119, 118, 115, 100, 85, 84, 83, 82] + [80.0] * 10
    df = add_indicators(pd.DataFrame({"Close": closes}, index=pd.bdate_range("2023-01-02", periods=len(closes))))
    event = Event(EventKind.GROUP_TURN_UP, 20)
    r = solve(df, event, days=10)
    ema20 = float(df["EMA20"].iloc[-1])
    assert ema20 > 82   # 门槛是 EMA20，不是 10 天里最低的抵扣价 82
    assert r.level == pytest.approx(ema20, rel=1e-6) and r.side == "以上"
    assert event.describe() == "20 线组一起拐头向上"


def test_golden_cross_from_a_falling_ma60_is_not_alignment():
    # TSLA 2021-04-14：持平在 247 时 10 天内 20 线组双双站上 60 线组，但那是 MA60 下行"让"出来的
    df = load_fixture("TSLA", "2021-04-14")
    assert occurs(df, Event(EventKind.DOUBLE_ABOVE, 20, 60), 247.0, 10)
    assert not occurs(df, Event(EventKind.ALIGN_UP, 20, 60), 247.0, 10)
    assert solve(df, Event(EventKind.ALIGN_UP, 20, 60), days=10).level > 260


def test_event_true_at_every_level_is_reported_not_solved():
    df = load_fixture("TSLA", "2021-03-04")
    # MA120 今天在 MA20 下方；两天内 MA20 不会掉到 MA120 下方，哪个价位都成立
    r = solve(df, Event(EventKind.BELOW, 20, 120, line="MA"), days=2, happen=False)
    assert (r.status, r.level) == (SolveStatus.ALWAYS, None)


def test_projection_is_json_safe():
    out = projection(load_fixture("TSLA", "2021-04-14"))
    json.dumps(out, ensure_ascii=False, allow_nan=False)
    assert set(out) == {"dates", "hurdles", "scenarios", "solves"}
    assert [h["period"] for h in out["hurdles"]] == list(dma.PERIODS)
    assert out["scenarios"][0]["name"] == "持平"


def test_projection_is_one_30_day_horizon_with_dates():
    out = projection(load_fixture("SPY", "2024-04-19"))
    # 推演第 1 天是下一个工作日；30 天的求解和 30 天的情景用同一串日期
    assert out["dates"][0] == "2024-04-22"
    assert len(out["dates"]) == out["scenarios"][0]["days"] == 30
    assert {s["days"] for s in out["solves"]} == {10, 20, 30}
