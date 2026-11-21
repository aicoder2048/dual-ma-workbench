"""完整计划逐笔回测：成交、止损、目标、仓位、风险上限、失效离场都和手算一致；每天的计划等于 dma_analyze.py --asof；不偷看未来。"""
from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest

from conftest import FIXTURES, SCRIPTS
import backtest as bt
import fullplan as fp
import plansim as ps

K = ps.Kind
NO_COST = ps.Config(cost=0.0, equity0=100_000)
INTRADAY = ps.Config(cost=0.0, equity0=100_000, stop_on_close=False)   # v1 口径：止损看盘中最低价


# ---------- 进场成交 ----------

@pytest.mark.parametrize("kind,entry,bar,want", [
    (K.STOP, 10.0, (10.5, 11.0, 10.2), 10.5),     # 跳空高开过进场价：按开盘
    (K.STOP, 10.0, (9.8, 10.2, 9.7), 10.0),       # 盘中碰到：按进场价
    (K.STOP, 10.0, (9.8, 9.9, 9.7), None),        # 没碰到：不成交
    (K.OPEN, 10.0, (9.6, 9.9, 9.5), 9.6),         # 按收盘进：次日开盘
    (K.LIMIT, 10.0, (9.7, 10.4, 9.6), 9.7),       # 低开到进场价下方：按开盘
    (K.LIMIT, 10.0, (10.3, 10.5, 9.9), 10.0),     # 盘中回落碰到：按进场价
    (K.LIMIT, 10.0, (10.3, 10.5, 10.1), None),
])
def test_entry_fill(kind, entry, bar, want):
    assert ps.fill_entry(kind, entry, *bar) == want


def test_entry_kind_follows_the_plan_price_against_the_close():
    assert ps.entry_kind(10.0, 9.5) == K.STOP
    assert ps.entry_kind(10.0, 10.0) == K.OPEN
    assert ps.entry_kind(9.5, 10.0) == K.LIMIT


# ---------- 止损、目标 ----------

@pytest.mark.parametrize("bar,want", [
    ((8.5, 9.5, 8.0), (8.5, "止损")),             # 跳空跌穿止损：按开盘
    ((13.5, 14.0, 13.2), (13.5, "目标")),         # 跳空越过目标：按开盘
    ((10.0, 13.5, 8.8), (9.0, "止损")),           # 同一根两个都碰到：先止损
    ((10.0, 10.5, 8.8), (9.0, "止损")),
    ((10.0, 13.1, 9.5), (13.0, "目标")),
    ((10.0, 12.0, 9.5), None),
])
def test_bar_exit(bar, want):
    assert ps.bar_exit(9.0, 13.0, *bar, entry_bar=False) == want


def test_entry_bar_checks_only_the_stop():
    assert ps.bar_exit(9.0, 13.0, 10.0, 13.5, 9.5, entry_bar=True) is None
    assert ps.bar_exit(9.0, 13.0, 10.0, 13.5, 8.9, entry_bar=True) == (9.0, "止损")


def test_no_target_holds_until_stop():
    assert ps.bar_exit(9.0, None, 10.0, 99.0, 9.5, entry_bar=False) is None


def test_without_an_intraday_stop_only_the_target_fills_during_the_bar():
    assert ps.bar_exit(None, 13.0, 10.0, 13.5, 8.0, entry_bar=False) == (13.0, "目标")
    assert ps.bar_exit(None, 13.0, 8.5, 9.5, 8.0, entry_bar=False) is None
    assert ps.bar_exit(None, 13.0, 10.0, 13.5, 8.0, entry_bar=True) is None


# ---------- 账户 ----------

def bars(rows: list[tuple[float, float, float, float]], f: list[float] | None = None) -> ps.Bars:
    a = np.array(rows, dtype=float)
    return ps.Bars(a[:, 0], a[:, 1], a[:, 2], a[:, 3], np.array(f or [1.0] * len(rows)))


def order(t="AAA", signal=0, entry=10.0, stop=9.0, target=13.0, kind=K.STOP, exits=(), **kw) -> ps.Order:
    return ps.Order(t, signal, kind, entry, stop, target, exits, **kw)


def run(b: dict[str, ps.Bars], orders: dict[int, list[ps.Order]], inval=None, cfg=NO_COST) -> ps.Result:
    n = len(next(iter(b.values())).o)
    inval = inval or {t: [frozenset()] * n for t in b}
    return ps.simulate(n, b, orders, inval, 0, cfg)


WIN = [(9.5, 9.6, 9.4, 9.5), (9.8, 10.2, 9.7, 10.1), (11.0, 13.5, 10.8, 13.2), (13.0, 13.1, 12.9, 13.0)]


def test_trade_sized_by_risk_hits_target_hand_computed():
    res = run({"AAA": bars(WIN)}, {0: [order()]})
    (t,) = res.trades
    # 可承受亏损 100000 × 1% = 1000，单位亏损 10 − 9 = 1 → 1000 股；10 买、13 卖
    assert (t.shares, t.fill, t.exit_px, t.reason, t.entry_i, t.exit_i) == (1000, 10.0, 13.0, "目标", 1, 2)
    assert t.pnl == pytest.approx(3000) and t.r == pytest.approx(3.0)
    assert res.equity.tolist() == pytest.approx([100_000, 100_000 + 1000 * (10.1 - 10), 103_000, 103_000])
    assert res.invested.tolist() == pytest.approx([0, 10_100 / 100_100, 0, 0])


def test_costs_come_off_both_sides():
    c = 0.0005
    (t,) = run({"AAA": bars(WIN)}, {0: [order()]}, cfg=ps.Config(cost=c, equity0=100_000)).trades
    pnl = 1000 * 13 * (1 - c) - 1000 * 10 * (1 + c)
    assert t.pnl == pytest.approx(pnl) and t.r == pytest.approx(pnl / 1000)


def test_same_bar_stop_and_target_counts_as_stop_intraday():
    rows = [WIN[0], WIN[1], (10.0, 13.5, 8.8, 12.0), WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}, cfg=INTRADAY).trades
    assert (t.exit_px, t.reason) == (9.0, "止损") and t.r == pytest.approx(-1.0)


def test_gap_below_stop_fills_at_open_and_loses_more_than_1r_intraday():
    rows = [WIN[0], WIN[1], (8.5, 8.7, 8.2, 8.4), WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}, cfg=INTRADAY).trades
    assert (t.exit_px, t.reason) == (8.5, "止损") and t.r == pytest.approx(-1.5)


def test_gap_up_entry_risk_is_measured_from_the_fill_intraday():
    rows = [WIN[0], (10.5, 10.6, 10.4, 10.5), (10.0, 10.1, 8.9, 9.0), WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}, cfg=INTRADAY).trades
    # 股数按计划进场价算（1000 股），成交在 10.5：初始风险 1000 × 1.5，亏 1500 → −1R
    assert (t.shares, t.fill) == (1000, 10.5) and t.r == pytest.approx(-1.0)


# 收盘口径（默认）：收盘跌破止损，次日开盘走

def test_intraday_dip_below_the_stop_that_closes_above_it_keeps_the_trade():
    rows = [WIN[0], WIN[1], (10.0, 10.3, 8.8, 9.2), (9.4, 9.6, 9.3, 9.5)]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    assert (t.reason, t.exit_px) == ("未平仓", 9.5)


def test_close_below_the_stop_exits_next_open_and_can_lose_more_than_1r():
    rows = [WIN[0], WIN[1], (9.5, 9.6, 8.7, 8.8), (8.6, 8.9, 8.5, 8.7)]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    # 1000 股 10 买；第 2 根收盘 8.8 跌破 9，第 3 根开盘 8.6 走：亏 1400，初始风险 1000 → −1.4R（不截到 −1）
    assert (t.exit_i, t.exit_px, t.reason) == (3, 8.6, "止损") and t.r == pytest.approx(-1.4)


def test_close_exactly_at_the_stop_is_not_a_break():
    rows = [WIN[0], WIN[1], (9.5, 9.6, 8.9, 9.0), (9.4, 9.6, 9.3, 9.5)]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    assert t.reason == "未平仓"


def test_entry_bar_closing_below_the_stop_exits_next_open():
    rows = [WIN[0], (9.8, 10.2, 8.9, 8.95), (8.7, 9.0, 8.6, 8.8), WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    assert (t.entry_i, t.exit_i, t.exit_px, t.reason) == (1, 2, 8.7, "止损") and t.r == pytest.approx(-1.3)


def test_target_reached_in_a_bar_that_dips_below_the_stop_is_a_win():
    rows = [WIN[0], WIN[1], (10.0, 13.5, 8.8, 12.0), WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    assert (t.exit_px, t.reason) == (13.0, "目标") and t.r == pytest.approx(3.0)


def test_stop_break_takes_precedence_over_an_invalidation_at_the_same_close():
    rows = [WIN[0], WIN[1], (9.5, 9.6, 8.7, 8.8), (8.6, 8.9, 8.5, 8.7)]
    inval = {"AAA": [frozenset(), frozenset(), frozenset({"EMA20 止损"}), frozenset()]}
    (t,) = run({"AAA": bars(rows)}, {0: [order(exits=("EMA20 止损",))]}, inval).trades
    assert t.reason == "止损"


def test_open_below_stop_is_not_entered():
    rows = [(9.5, 9.6, 9.4, 9.5), (8.9, 9.2, 8.8, 9.0), WIN[2], WIN[3]]
    res = run({"AAA": bars(rows)}, {0: [order(kind=K.OPEN, entry=9.5)]})
    assert res.trades == [] and res.skipped == {"开盘已破止损": 1}


def test_untriggered_order_expires_after_one_day():
    rows = [WIN[0], (9.6, 9.9, 9.5, 9.8), (9.8, 10.5, 9.7, 10.4), WIN[3]]
    res = run({"AAA": bars(rows)}, {0: [order()]})
    assert res.trades == [] and res.skipped == {"没触发": 1}


def test_entry_bar_stop_exits_at_the_stop_intraday():
    rows = [WIN[0], (9.8, 10.2, 8.9, 9.1), WIN[2], WIN[3]]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}, cfg=INTRADAY).trades
    assert (t.entry_i, t.exit_i, t.exit_px) == (1, 1, 9.0)


def test_invalidation_at_close_exits_next_open():
    rows = [WIN[0], WIN[1], (10.2, 10.4, 10.0, 10.1), (10.3, 10.6, 10.2, 10.5)]
    inval = {"AAA": [frozenset(), frozenset(), frozenset({"EMA20 止损", "P3"}), frozenset()]}
    (t,) = run({"AAA": bars(rows)}, {0: [order(exits=("EMA20 止损",))]}, inval).trades
    assert (t.exit_i, t.exit_px, t.reason) == (3, 10.3, "失效：EMA20 止损") and t.r == pytest.approx(0.3)


def test_condition_not_in_this_plays_exits_is_ignored():
    rows = [WIN[0], WIN[1], (10.2, 10.4, 10.0, 10.1), (10.3, 10.6, 10.2, 10.5)]
    inval = {"AAA": [frozenset(), frozenset(), frozenset({"P3"}), frozenset()]}
    (t,) = run({"AAA": bars(rows)}, {0: [order(exits=("EMA20 止损",))]}, inval).trades
    assert t.reason == "未平仓" and t.exit_px == 10.5


def test_no_new_order_for_a_ticker_held_at_the_signal_close_intraday():
    # 第 1 根进场；第 1 根收盘又出计划，那时还拿着，不该下单，哪怕第 2 根开盘先止损走了
    rows = [WIN[0], WIN[1], (8.5, 10.6, 8.4, 10.5), (10.6, 10.7, 10.5, 10.6)]
    res = run({"AAA": bars(rows)}, {0: [order()], 1: [order(signal=1, entry=10.5, stop=9.5, target=14.0)]}, cfg=INTRADAY)
    assert [(t.signal, t.reason) for t in res.trades] == [(0, "止损")]


def test_total_open_risk_cap_skips_the_trade_that_would_break_it():
    b = {t: bars(WIN) for t in ("AAA", "BBB")}
    res = run(b, {0: [order("BBB"), order("AAA")]}, cfg=ps.Config(cost=0.0, equity0=100_000, cap_pct=1.5))
    assert [t.ticker for t in res.trades] == ["AAA"] and res.skipped == {"超总风险上限": 1}   # 按票代码排序，AAA 先


def test_no_leverage_shares_capped_by_cash():
    # 止损只差 0.1：按风险要 10000 股（10 万元），账户只有 10 万，含成本只够 9995 股
    (t,) = run({"AAA": bars(WIN)}, {0: [order(stop=9.9)]}, cfg=ps.Config(cost=0.0005, equity0=100_000)).trades
    assert t.shares == 9995


def test_position_cap_limits_a_tiny_stop_trade_to_a_share_of_equity():
    # 止损只差 0.1：按风险要 10000 股（10 万元，整个账户）；单票上限 25% → 2.5 万元，2500 股
    (t,) = run({"AAA": bars(WIN)}, {0: [order(stop=9.9)]}, cfg=ps.Config(cost=0.0, equity0=100_000, max_position=0.25)).trades
    assert t.shares == 2500 and t.notional == pytest.approx(0.25)


def test_position_cap_leaves_a_normal_stop_sized_by_risk():
    (t,) = run({"AAA": bars(WIN)}, {0: [order()]}, cfg=ps.Config(cost=0.0, equity0=100_000, max_position=0.25)).trades
    assert t.shares == 1000


def test_open_risk_counts_the_capped_shares():
    # 第一笔被单票上限压到 2500 股，占用风险 2500 × 0.1 = 250，不是按风险算的 10000 股的 1000；第二笔（风险 1000）还放得下 1.5% 的总上限
    b = {t: bars(WIN) for t in ("AAA", "BBB")}
    cfg = ps.Config(cost=0.0, equity0=100_000, cap_pct=1.5, max_position=0.25)
    res = run(b, {0: [order("AAA", stop=9.9), order("BBB")]}, cfg=cfg)
    assert [(t.ticker, t.shares) for t in res.trades] == [("AAA", 2500), ("BBB", 1000)]


def test_equal_notional_ignores_the_stop_distance():
    (t,) = run({"AAA": bars(WIN)}, {0: [order(stop=9.9)]}, cfg=ps.Config(cost=0.0, equity0=100_000, notional_pct=0.2)).trades
    assert t.shares == 2000 and t.notional == pytest.approx(0.2)


def test_dividends_grow_the_position_through_the_adjustment_factor():
    # 第 2 根除息：复权因子之前 0.98、之后 1（之前的价格要乘 0.98 才和之后可比）
    rows = [WIN[0], WIN[1], (10.0, 10.2, 9.8, 10.0), (10.0, 10.2, 9.8, 10.0)]
    (t,) = run({"AAA": bars(rows, [0.98, 0.98, 1.0, 1.0])}, {0: [order(target=None)]}).trades
    assert t.pnl == pytest.approx(1000 * 10.0 * (1.0 / 0.98) - 10_000)


def test_open_trade_marks_to_last_close():
    rows = [WIN[0], WIN[1], (10.2, 10.4, 10.0, 10.1), (10.3, 10.6, 10.2, 10.5)]
    (t,) = run({"AAA": bars(rows)}, {0: [order()]}).trades
    assert (t.reason, t.exit_i, t.exit_px) == ("未平仓", 3, 10.5)


def test_later_bars_do_not_change_earlier_trades():
    rows = WIN + [(13.0, 13.1, 12.9, 13.0)] * 3
    a = run({"AAA": bars(rows)}, {0: [order()], 3: [order(signal=3, entry=14.0, stop=12.0, target=20.0)]})
    changed = rows[:4] + [(r[0] * 3, r[1] * 3, r[2] * 3, r[3] * 3) for r in rows[4:]]
    b = run({"AAA": bars(changed)}, {0: [order()], 3: [order(signal=3, entry=14.0, stop=12.0, target=20.0)]})
    assert a.trades[0] == b.trades[0] and a.equity[:4].tolist() == b.equity[:4].tolist()


# ---------- 指标 ----------

def trade(r: float, exit_i: int, ticker: str = "AAA") -> ps.Trade:
    return ps.Trade(ticker, "", "", "", 0, 0, exit_i, 10, 9, 13, 3, 10, 10 + r, 1, "", r, r, 0.1)


def test_longest_losing_streak_follows_exit_order():
    ts = [trade(-1, 1), trade(2, 2), trade(-1, 3), trade(-0.5, 4, "BBB"), trade(-1, 4, "AAA"), trade(1, 5)]
    assert ps.longest_losing_streak(ts) == 3


def test_payoff_is_average_win_over_average_loss():
    assert ps.payoff(np.array([3.0, 1.0, -1.0, -0.5])) == pytest.approx(2.0 / 0.75)
    assert ps.payoff(np.array([1.0, 2.0])) is None


def test_cagr_and_drawdown_hand_computed():
    eq = np.array([100.0, 120.0, 90.0, 121.0])
    assert ps.max_drawdown(eq) == pytest.approx(-0.25)
    assert ps.cagr(eq, days_per_year=3) == pytest.approx(0.21)


BC = {"level": 0.9, "reps": 500, "block_days": 2, "seed": 7}


def test_expectancy_interval_resamples_date_blocks():
    cal = [f"2024-01-{d:02d}" for d in range(1, 21)]
    ts = [ps.Trade("A", "", "", "", 0, i, i + 1, 10, 9, 13, 3, 10, 11, 1, "", r, r, 0.1)
          for i, r in zip(range(0, 20, 2), [2, -1, 3, -1, -1, 2, -1, 1, -1, 4])]
    res = ps.Result(ts, np.array([1.0, 1.1]), np.array([0.0, 0.5]))
    s = fp.summarize(res, cal, BC)
    assert s["mean_r"] == pytest.approx(0.7) and s["blocks"] == 10
    assert s["ci"][0] < 0.7 < s["ci"][1] and s["win"] == pytest.approx(0.5)


def test_one_block_has_no_interval():
    cal = ["2024-01-01", "2024-01-02"]
    ts = [ps.Trade("A", "", "", "", 0, 0, 1, 10, 9, 13, 3, 10, 11, 1, "", r, r, 0.1) for r in (1.0, -1.0)]
    assert fp.summarize(ps.Result(ts, np.array([1.0, 1.0]), np.array([0.0, 0.0])), cal, BC)["ci"] is None


# ---------- 诊断：止损距离按 ATR ----------

def test_atr_is_wilders_average_true_range_including_gaps():
    df = pd.DataFrame({"High": [11.0, 12.0, 12.0, 15.0], "Low": [9.0, 10.0, 10.0, 13.0], "Close": [10.0, 11.0, 11.0, 14.0]})
    # 真实波幅：2、2、2、max(2, |15 − 11|, |13 − 11|) = 4；n = 2 的 Wilder 平均：第 2 根起 2、2，然后 (2 + 4) / 2 = 3
    assert fp.atr(df, 2).tolist()[1:] == pytest.approx([2.0, 2.0, 3.0])


def test_atr_on_a_day_ignores_later_bars():
    df = pd.DataFrame({"High": [11.0, 12.0, 12.0, 15.0], "Low": [9.0, 10.0, 10.0, 13.0], "Close": [10.0, 11.0, 11.0, 14.0]})
    later = df.copy()
    later.iloc[3] = [50.0, 1.0, 30.0]
    pd.testing.assert_series_equal(fp.atr(df, 2).iloc[:3], fp.atr(later, 2).iloc[:3])


def test_trade_pnl_as_a_share_of_equity_ignores_the_stop_distance():
    from dataclasses import asdict
    (t,) = run({"AAA": bars(WIN)}, {0: [order()]}).trades
    assert fp.equity_pnl(asdict(t)) == pytest.approx(3000 / 100_000)       # 赚 3000，进场前净值 10 万


# ---------- 计划 → 单：消融开关 ----------

def rec(d: str, verdict: str | None, rule: str = "P19、P20", entry=10.0, stop=9.0, t1: float | None = 13.0,
        key: str = "多头结构回撤中") -> dict:
    return {"i": 0, "d": d, "key": key, "entry": entry, "rule": rule, "stop": stop, "t1": t1, "t2": None, "rr": 3.0,
            "verdict": verdict, "x": []}


DAYS = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
POS = {d: k for k, d in enumerate(DAYS)}
B = {"AAA": bars([(9.5, 9.6, 9.4, 9.5)] * 4)}
RECS = {"AAA": [rec(DAYS[0], "可做"), rec(DAYS[1], "不做"), rec(DAYS[2], "理想", rule="P13", key="稳定上涨"),
                rec(DAYS[3], None, t1=None)]}


def flat(orders: dict[int, list[ps.Order]]) -> list[ps.Order]:
    return [o for k in sorted(orders) for o in orders[k]]


def test_rr_filter_keeps_only_tradeable_verdicts():
    assert [o.signal for o in flat(fp.orders_for(RECS, POS, B, fp.FULL))] == [0, 2]
    assert [o.signal for o in flat(fp.orders_for(RECS, POS, B, fp.Variant("x", rr_filter=False)))] == [0, 1, 2, 3]


def test_targets_off_and_hourly_skip_switches():
    assert {o.target for o in flat(fp.orders_for(RECS, POS, B, fp.Variant("x", targets=False)))} == {None}
    assert [o.rule for o in flat(fp.orders_for(RECS, POS, B, fp.Variant("x", skip_hourly=True)))] == ["P19、P20"]


def test_pullback_waypoint_is_not_an_entry_unless_asked():
    recs = {"AAA": [rec(DAYS[0], "可做", rule="P11", key="稳定上涨", entry=9.0, stop=8.5)]}
    assert fp.orders_for(recs, POS, B, fp.FULL) == {}
    (o,) = flat(fp.orders_for(recs, POS, B, fp.Variant("x", waypoint=True)))
    assert o.kind == K.LIMIT                           # 回撤价 9 低于收盘 9.5


def test_orders_carry_the_plays_invalidation_and_entry_kind():
    o = flat(fp.orders_for(RECS, POS, B, fp.FULL))
    assert o[0].exits == ("EMA20 止损", "J16 双死叉") and o[1].exits == ("60 线组拐头向下",)
    assert o[0].kind == K.STOP                         # 进场 10 高于收盘 9.5
    assert fp.invalidation("加速下跌") == ("EMA20 止损",)


def test_plan_without_a_usable_stop_gives_no_order():
    recs = {"AAA": [rec(DAYS[0], "可做", stop=None), rec(DAYS[1], "可做", stop=10.0), rec(DAYS[2], "可做", entry=None)]}
    assert fp.orders_for(recs, POS, B, fp.Variant("x", rr_filter=False)) == {}


def test_random_entry_keeps_count_distances_and_holding_cap():
    real = [ps.Trade("AAA", "", "", "", 0, 1, 3, 10.0, 9.0, 13.0, 3.0, 10.0, 13.0, 1, "目标", 3, 3, 0.1)]
    a = fp.random_orders(real, RECS, POS, B, np.random.default_rng(1))
    b = fp.random_orders(real, RECS, POS, B, np.random.default_rng(1))
    (o,) = flat(a)
    assert a == b and o.kind == K.OPEN and o.max_bars == 2 and o.exits == ()
    assert o.stop / o.entry == pytest.approx(0.9) and o.target / o.entry == pytest.approx(1.3)


# ---------- 每天的计划：等于 CLI、不偷看未来 ----------

def plain(x):
    return json.loads(json.dumps(x, ensure_ascii=False))


@pytest.mark.parametrize("ticker,date", [("SPY", "2022-06-15"), ("TSLA", "2021-04-14"), ("GOOGL", "2024-08-05"),
                                         ("AAPL", "2021-05-03")])
def test_daily_plan_equals_cli_trade_plan(tmp_path, ticker, date):
    px = bt.load(FIXTURES / f"{ticker}.csv")
    i = px.index.get_loc(pd.Timestamp(date))
    csv = tmp_path / f"{ticker}.csv"
    bt.history_at(px, i).to_csv(csv)
    proc = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(csv), "--asof", date, "--json"],
                          capture_output=True, text=True, check=True)
    cli = json.loads(proc.stdout)["analysis"]["trade_plan"]
    plan, _ = fp.light_plan(bt.cut_at(px, i), bt.history_at(px, i))
    assert plan == plain(cli)
    r = fp.plan_day(px, i, ticker, check=True)        # 和完整分析对过（计划和失效条件）
    f = cli["flat"]
    assert (r["key"], r["entry"], r["stop"], r["verdict"]) == (cli["key"], f["entry"] and f["entry"]["price"],
                                                               f["stop"] and f["stop"]["price"], f["rr_verdict"])


def group(ci, mar, ma200_mar) -> dict:
    return {"runs": {fp.FULL.name: {"ci": ci, "mar": mar}}, "baselines": {"MA200 朴素规则": {"mar": ma200_mar}}}


def test_core_gate_needs_interval_above_zero_and_mar_at_least_ma200():
    assert fp.gate(group([0.05, 0.4], 0.5, 0.4)) == (True, [])
    ok, why = fp.gate(group([-0.1, 0.3], 0.5, 0.4))
    assert not ok and "跨 0" in why[0]
    ok, why = fp.gate(group([0.05, 0.4], 0.2, 0.4))
    assert not ok and "MAR 0.20 低于 MA200 朴素规则的 0.40" in why[0]
    assert len(fp.gate(group(None, None, 0.4))[1]) == 2


def test_daily_plan_ignores_later_prices():
    px = bt.load(FIXTURES / "SPY.csv")
    i = px.index.get_loc(pd.Timestamp("2024-04-19"))
    later = px.copy()
    later.iloc[i + 1:] = later.iloc[i + 1:] * 3
    assert fp.plan_day(later, i, "SPY", False) == fp.plan_day(px, i, "SPY", False)
