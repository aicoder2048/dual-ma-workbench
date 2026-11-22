"""交易计划（tradeplan.py）：仓位公式、盈亏比档位、目标位、各打法的进场和止损，和三个基准日的计划。

数字都是手算的：仓位用视频 F 的例子（买 2.66、止损 2.57、最多亏 1000 元 → 11111 股）。
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
import pytest

from conftest import load_fixture
import dma_analyze as dma
import rules
import tradeplan as tp
from indicators import add_indicators
from projection import extend
from structure import Pivot
from volprofile import Mountain, Profile


# ---------- 仓位（A6） ----------

def test_video_f_example_rounds_down_to_11111_shares():
    size, why = tp.size_position(2.66, 2.57, tp.Sizing(risk_amount=1000))
    assert why is None and size.shares == 11111 and size.unit_risk == pytest.approx(0.09)


def test_float_noise_in_the_distance_does_not_lose_a_share():
    # 10.3 − 10.2 在浮点里是 0.10000000000000142，直接除会得到 999.99…
    size, _ = tp.size_position(10.3, 10.2, tp.Sizing(risk_amount=100))
    assert size.shares == 1000


def test_default_risk_is_one_percent_of_the_account():
    size, _ = tp.size_position(50.0, 48.0, tp.Sizing(account=100_000))
    assert size.risk_amount == 1000 and size.shares == 500


def test_fixed_amount_wins_over_the_percentage():
    size, _ = tp.size_position(50.0, 48.0, tp.Sizing(account=100_000, risk_pct=1, risk_amount=300))
    assert size.shares == 150


def test_without_an_account_only_shares_per_10k_of_risk():
    size, _ = tp.size_position(50.0, 48.0, tp.Sizing())
    assert size.shares is None and size.risk_amount is None and size.per_10k == 5000


def test_shares_capped_by_what_the_account_can_buy():
    # 风险 1000 ÷ 0.05 = 20000 股，要 200 万；账户只有 10 万 → 1000 股
    size, _ = tp.size_position(100.0, 99.95, tp.Sizing(account=100_000))
    assert size.capped and size.shares == 1000


@pytest.mark.parametrize(("entry", "stop"), [(50.0, 50.0), (50.0, 51.0)])
def test_stop_not_below_entry_gives_no_size(entry, stop):
    size, why = tp.size_position(entry, stop, tp.Sizing(account=100_000))
    assert size is None and "下方，算不了股数" in why


def test_stop_within_a_cent_cannot_be_executed():
    size, why = tp.size_position(50.0, 49.995, tp.Sizing(account=100_000))
    assert size is None and "1 分钱" in why


def test_missing_stop_gives_no_size():
    size, why = tp.size_position(50.0, None, tp.Sizing(account=100_000))
    assert size is None and "止损" in why


# ---------- 盈亏比（P24） ----------

@pytest.mark.parametrize(("rr", "verdict"), [(2.99, "不做"), (3.0, "可做"), (4.99, "可做"), (5.0, "理想"), (None, None)])
def test_rr_verdict_boundaries(rr, verdict):
    assert tp.rr_verdict(rr) == verdict


def test_exact_3_to_1_survives_float_noise():
    rr = tp.reward_risk(10.2, 10.1, 10.5)   # 0.3 / 0.1，浮点里是 2.9999999999999822
    assert tp.rr_verdict(rr) == "可做"


def test_reward_risk_needs_a_target_above_and_a_stop_below():
    assert tp.reward_risk(100, 95, 115) == pytest.approx(3.0)
    assert tp.reward_risk(100, 100, 115) is None
    assert tp.reward_risk(100, 95, 99) is None


# ---------- 目标位（P25） ----------

def lines_frame() -> pd.DataFrame:
    """40 根：MA60 从 200 线性跌到 100，线平时散开（相差 > 20%）；第 25–27 根 20、60 四条线靠在 120，第 30–32 根六条线都靠在 130。

    收盘一直在 120 下方：两个密集区都没被冲过去。"""
    n = 40
    ma60 = [200 - i * 100 / (n - 1) for i in range(n)]
    rows = []
    for i, m in enumerate(ma60):
        row = {"Close": m * 0.8, "MA20": m * 0.8, "EMA20": m * 0.8, "MA60": m, "EMA60": m, "MA120": m * 1.2, "EMA120": m * 1.2}
        if 25 <= i <= 27:
            row.update(Close=120, MA20=120, EMA20=120.5, MA60=120, EMA60=119.5)
        if 30 <= i <= 32:
            row.update({k: 130.0 for k in row}, Close=119)
        rows.append(row)
    return pd.DataFrame(rows, index=pd.bdate_range("2024-01-01", periods=n))


def test_dense_zones_formed_while_ma60_falls():
    zones = tp.dense_zones_above(lines_frame(), 100)
    got = sorted((z.kind, round(z.price, 2)) for z in zones)
    assert got == [("20、60 均线密集", 120.0), ("20、60 均线密集", 130.0), ("20、60、120 全部汇聚", 130.0)]


def test_first_target_nearest_second_the_full_convergence_above_it():
    t = tp.find_targets(lines_frame(), None, 100)
    assert [(x.kind, round(x.price, 2)) for x in t] == [("20、60 均线密集", 120.0), ("20、60、120 全部汇聚", 130.0)]


def test_zone_a_later_close_went_above_is_no_longer_a_target():
    """视频 G 40:03 冲过去了就找下一个目标位：密集区形成以后收盘站上过它，它就不再是目标。"""
    df = lines_frame()
    df.iloc[34, df.columns.get_loc("Close")] = 121   # 120 的密集区形成以后有一天收在它上方，之后又跌下来
    t = tp.find_targets(df, None, 100)
    assert (t[0].kind, round(t[0].price, 2)) == ("20、60 均线密集", 130.0)   # 120 那个不在了


def test_zone_still_forming_today_is_not_a_target():
    df = lines_frame().iloc[:27]   # 最后一根还在 120 的密集区里
    assert tp.dense_zones_above(df, 100) == []


def test_unfilled_gap_down_target_is_the_unfilled_bottom():
    idx = pd.bdate_range("2024-01-01", periods=6)
    df = pd.DataFrame({"High": [112, 111, 105, 107, 104, 103], "Low": [109, 110, 101, 102, 100, 99]}, index=idx)
    # 第 3 根最高 105 < 前一根最低 110：缺口 105~110；之后最高到过 107，没补的是 107~110
    gaps = tp.gaps_above(df, 100)
    assert [(g.price, g.date) for g in gaps] == [(107, "2024-01-03")]


def test_gap_list_for_the_chart_is_the_same_gap_with_its_unfilled_part():
    idx = pd.bdate_range("2024-01-01", periods=6)
    df = pd.DataFrame({"High": [112, 111, 105, 107, 104, 103], "Low": [109, 110, 101, 102, 100, 99]}, index=idx)
    assert tp.gaps_json(df) == [{"date": "2024-01-03", "top": 110, "bottom": 107}]


def test_filled_gap_is_not_a_target():
    idx = pd.bdate_range("2024-01-01", periods=4)
    df = pd.DataFrame({"High": [112, 105, 111, 104], "Low": [110, 101, 103, 100]}, index=idx)
    assert tp.gaps_above(df, 100) == []
    assert tp.gaps_json(df) == []


def test_previous_high_when_nothing_above():
    df = lines_frame().iloc[:20]
    st = SimpleNamespace(pivots=[Pivot("高", "2024-01-05", 150.0), Pivot("低", "2024-01-10", 90.0), Pivot("高", "2024-01-20", 140.0)])
    t = tp.find_targets(df, st, 200) + tp.find_targets(df, st, 100)
    assert [(x.kind, x.price, x.source) for x in t] == [("前高", 140.0, "解读")]


# ---------- 筹码山只作参考价位（P38，docs/adr/0018.md）：不进 targets ----------

def profile_with(*bands: tuple[float, float]) -> Profile:
    return Profile("2023-01-02", "2024-02-23", 250, [], [], [Mountain(a, b, 1.0, 0.1) for a, b in bands])


def test_reference_mountain_is_the_nearest_whole_one_above():
    m = tp.mountain_above(profile_with((110, 115), (125, 128)), 100)
    assert (m.foot, m.top, m.date) == (110, 115, "2023-01-02~2024-02-23")


def test_mountain_the_price_is_already_in_is_not_the_reference():
    assert tp.mountain_above(profile_with((95, 105)), 100) is None
    assert tp.mountain_above(profile_with((95, 105), (125, 128)), 100).foot == 125


def test_no_reference_mountain_without_a_profile():
    assert tp.mountain_above(None, 100) is None


# ---------- 进场和止损 ----------

def ctx_of(closes: list[float], ema20: float) -> SimpleNamespace:
    df = pd.DataFrame({"Close": closes, "EMA20": ema20}, index=pd.bdate_range("2024-01-01", periods=len(closes)))
    return SimpleNamespace(df=df, row=df.iloc[-1], close=closes[-1])


def test_20_line_turn_entry_above_both_and_stop_at_the_lower_failure_price():
    closes = [100.0] * 30
    closes[-20], closes[-19], closes[-1] = 105.0, 98.0, 95.0   # 明天扣 105，后天扣 98
    entry, stop = tp._turn20(ctx_of(closes, ema20=100.0), "P19、P20")
    assert entry.price == 105.0 and stop.price == 98.0 and stop.rule == "P23"


def test_20_line_turn_already_above_both_enters_at_the_close():
    closes = [100.0] * 30
    closes[-20], closes[-19], closes[-1] = 101.0, 99.0, 110.0
    entry, stop = tp._turn20(ctx_of(closes, ema20=104.0), "P20")
    assert entry.price == 110.0 and stop.price == 99.0


# 触发价离现价还远（docs/adr/0026.md）：明天的抵扣价很高、几天后回落，明天的触发价不代表 20 线组什么时候真会拐头

def turn_ctx(last20: list[float]) -> SimpleNamespace:
    """前 200 根收在 100，最后 20 根照给的：明天扣 last20[0]，第 k 天扣 last20[k-1]。指标照脚本算。"""
    closes = [100.0] * 200 + last20
    df = add_indicators(pd.DataFrame({"Close": closes}, index=pd.bdate_range("2024-01-01", periods=len(closes))))
    return SimpleNamespace(df=df, row=df.iloc[-1], close=closes[-1])


QQQ_LIKE = [120, 121, 119, 118, 115, 100, 85, 84, 83, 82] + [80.0] * 10   # 明天扣 120，第 7 天起扣到 85 以下


def test_far_trigger_gives_the_projected_level_and_earliest_day():
    c = turn_ctx(QQQ_LIKE)
    ema20 = float(c.row["EMA20"])
    entry, stop = tp._turn20(c, "J19")
    assert entry.price == 120.0 and stop.price == ema20   # 进场、止损照旧（明天扣 120，后天扣 121）：回测读这两个
    far = entry.far
    assert far.days == tp.TURN_DAYS
    assert far.level == pytest.approx(ema20, rel=1e-6)   # 持平在 EMA20 上方 EMA20 天天向上；MA20 第 7 天扣 85 才向上
    assert far.day == 7


def test_far_trigger_level_is_where_both_lines_first_turn_up_together():
    c = turn_ctx(QQQ_LIKE)
    far = tp._turn20(c, "J19")[0].far
    ext = extend(c.df, [far.level] * far.days)
    both = ((ext["MA20"].diff() > 0) & (ext["EMA20"].diff() > 0)).iloc[-far.days:].tolist()
    assert both.index(True) + 1 == far.day
    lower = extend(c.df, [far.level * (1 - 1e-4)] * far.days)
    assert not ((lower["MA20"].diff() > 0) & (lower["EMA20"].diff() > 0)).iloc[-far.days:].any()


def test_far_trigger_condition_says_when_and_where_and_still_names_tomorrow():
    c = turn_ctx(QQQ_LIKE)
    entry = tp._turn20(c, "J19")[0]
    level = f"{entry.far.level:.2f}"
    assert entry.condition.startswith(f"按收盘持平推演，20 线组最早约 7 个交易日后、收盘站上 {level} 才会一起拐头；明天要拐头得站上 120.00")


def test_trigger_not_far_when_the_high_drop_lasts_the_whole_window():
    """10 天里天天扣 120：推演门槛也是 120，明天的触发价就是实际要过的价位。"""
    entry = tp._turn20(turn_ctx([120.0] * 10 + [80.0] * 10), "P19、P20")[0]
    assert entry.price == 120.0 and entry.far is None
    assert entry.condition.startswith("收盘站上 EMA20")


def test_trigger_not_far_when_tomorrow_is_within_the_threshold_of_ema20():
    entry = tp._turn20(turn_ctx([101.0] + [100.0] * 18 + [99.0]), "P19、P20")[0]
    assert entry.price == 101.0 and entry.far is None


def test_no_far_trigger_once_the_close_is_already_above_both():
    entry = tp._turn20(turn_ctx([90.0] * 19 + [130.0]), "P20")[0]
    assert entry.price == 130.0 and entry.far is None


def test_breakout_bar_is_the_first_close_above_the_box_in_the_last_run():
    closes = [99.0] * 5 + [98, 99, 97, 101, 103, 99, 104, 105, 106, 107]
    lows = [c - 2 for c in closes]
    df = pd.DataFrame({"Close": closes, "Low": lows}, index=pd.bdate_range("2024-01-01", periods=len(closes)))
    bar = tp._breakout_bar(SimpleNamespace(df=df), 100.0)
    assert bar["Close"] == 104 and bar["Low"] == 102


def test_old_breakout_is_not_a_fresh_one():
    closes = [101.0] * 15
    df = pd.DataFrame({"Close": closes, "Low": [100.5] * 15}, index=pd.bdate_range("2024-01-01", periods=15))
    assert tp._breakout_bar(SimpleNamespace(df=df), 100.0) is None


# ---------- J37：只当旁证 ----------

def j37_ctx(close: float, weekly: dict) -> SimpleNamespace:
    return SimpleNamespace(row=pd.Series({"EMA120": 100.0}), close=close, weekly=weekly)


@pytest.mark.parametrize(("close", "met"), [(150.0, True), (149.9, False), (50.0, True), (50.1, False)])
def test_j37_daily_bias_50_percent(close, met):
    r = rules.j37_extreme_bias(j37_ctx(close, {"available": False}))
    assert (r.status == rules.Status.MET) == met


def test_j37_weekly_bias_70_percent():
    weekly = {"available": True, "close": 171.0, "lines": [{"period": 120, "ma": 90.0, "ema": 100.0}]}
    assert rules.j37_extreme_bias(j37_ctx(110.0, weekly)).status == rules.Status.MET


# ---------- 基准日：计划可复现 ----------

@pytest.fixture(scope="module")
def plans() -> dict:
    return {t: dma.analyze(load_fixture(t, d), t, "fixture")
            for t, d in (("SPY", "2024-04-19"), ("TSLA", "2021-04-14"), ("GOOGL", "2025-04-08"))}


def band(m: dict) -> tuple[float, float, str]:
    return round(m["foot"], 2), round(m["top"], 2), m["date"]


def test_p38_spy_crash_bottom_mountain_above_is_a_reference_and_targets_stay_as_without_it():
    """筹码山 318.94 比前高 313.10 远：不进 targets，盈亏比照前高算。持仓是加速下跌，不找目标，山照样记着作参考。"""
    a = dma.analyze(load_fixture("SPY", "2020-03-23"), "SPY", "fixture")
    f, h = a["trade_plan"]["flat"], a["trade_plan"]["holding"]
    assert [(t["kind"], round(t["price"], 2)) for t in f["targets"]] == [("前高", 313.1)]
    assert a["trade_plan"]["key"] == "加速下跌" and h["targets"] == []
    assert f["rr"] == pytest.approx(0.0105, abs=0.0001)
    assert band(f["mountain"]) == (318.94, 323.98, "2019-03-25~2020-03-23")   # 从进场价 312.65 往上找
    assert band(h["mountain"]) == (278.67, 313.91, "2019-03-25~2020-03-23")   # 从现价 222.95 往上找
    p38 = next(r for r in a["rules"] if r["id"] == "P38")
    assert p38["status"] == "满足" and p38["levels"] == {"山脚": f["mountain"]["foot"], "山顶": f["mountain"]["top"]}
    assert "318.94–323.98" in p38["basis"] and "只作参考" in p38["basis"] and "不算盈亏比" in p38["basis"]


def test_p38_unmet_when_no_whole_mountain_is_above_the_entry(plans):
    a = plans["SPY"]
    assert a["trade_plan"]["flat"]["mountain"] is None and a["trade_plan"]["holding"]["mountain"] is None
    p38 = next(r for r in a["rules"] if r["id"] == "P38")
    assert p38["status"] == "不满足" and "进场价 500.46 上方没有整座的筹码山" in p38["basis"]


def test_no_plan_lists_a_mountain_among_its_targets(plans):
    for a in plans.values():
        for side in ("flat", "holding"):
            for t in a["trade_plan"][side]["targets"]:
                assert t["kind"] != "筹码山" and "top" not in t


def test_text_report_names_the_mountain_as_a_reference_not_a_target(plans):
    lines = [x for x in dma.plan_lines(plans["GOOGL"]["trade_plan"]) if x.startswith("- 空仓")]
    assert "阻力位/目标位：178.74（缺口，2025-02-25）" in lines[0]
    assert "上方最近的筹码山 182.11–184.88，只作参考，不算盈亏比（P38）" in lines[0]


def test_spy_pullback_plan_is_short_of_3_to_1(plans):
    a = plans["SPY"]
    f = a["trade_plan"]["flat"]
    assert a["trade_plan"]["key"] == "稳定上涨"
    assert f["entry"]["rule"] == "P12" and f["entry"]["price"] == pytest.approx(500.46, abs=0.01)
    assert f["stop"]["price"] == pytest.approx(488.03, abs=0.01) and f["stop"]["source"] == "解读"
    assert [(t["kind"], round(t["price"], 2)) for t in f["targets"]] == [("前高", 524.61)]
    assert f["rr"] == pytest.approx(1.94, abs=0.01) and f["rr_verdict"] == "不做"
    assert f["size"]["per_10k"] == 804 and f["size"]["shares"] is None
    assert "不做（P24）" in a["play"]["text"] and "P24" in a["play"]["rules"]
    assert a["trade_plan"]["holding"]["stop"] == f["stop"]


def test_tsla_bounce_has_no_entry_and_holding_stop_is_ema20(plans):
    tpj = plans["TSLA"]["trade_plan"]
    assert tpj["key"] == "空头结构反弹中" and tpj["flat"]["entry"] is None and tpj["flat"]["size"] is None
    assert tpj["holding"]["stop"]["price"] == pytest.approx(228.95, abs=0.01)
    assert tpj["holding"]["risk_pct"] == pytest.approx(6.20, abs=0.01)


def test_googl_bottom_turn_plan_targets_the_gap(plans):
    f = plans["GOOGL"]["trade_plan"]["flat"]
    assert f["entry"]["price"] == pytest.approx(167.11, abs=0.01)
    assert f["stop"]["price"] == pytest.approx(158.37, abs=0.01)
    assert [(t["kind"], round(t["price"], 2)) for t in f["targets"]] == [("缺口", 178.74)]
    assert f["rr"] == pytest.approx(1.33, abs=0.01) and f["rr_verdict"] == "不做"
    assert f["rr_gap"]["target_for_min"] == pytest.approx(193.34, abs=0.01)
    assert plans["GOOGL"]["trade_plan"]["holding"]["stop"] is None


def test_gap_target_is_one_of_the_gaps_the_chart_draws(plans):
    a = plans["GOOGL"]
    target = a["trade_plan"]["flat"]["targets"][0]
    drawn = {(g["date"], g["bottom"]) for g in a["gaps"]}
    assert (target["date"], target["price"]) in drawn
    assert all(g["bottom"] < g["top"] and g["bottom"] > a["close"] for g in a["gaps"])


# ---------- 到第一目标（P25）：检查点，不是自动离场 ----------

@pytest.mark.parametrize(("key", "hold"), [("稳定上涨", True), ("加速上涨", True), ("多头结构回撤中", False), ("横盘", False),
                                           ("横盘破位", False), ("过渡", False), ("加速下跌", False), ("空头结构反弹中", False)])
def test_first_target_holds_only_while_60_120_still_trend_up(key, hold):
    assert tp.holds_past_target(key) is hold


def test_steady_uptrend_plan_keeps_holding_past_the_first_target(plans):
    f = plans["SPY"]["trade_plan"]["flat"]
    assert "524.61" in f["at_target"] and "就继续拿，按止损和失效离场" in f["at_target"]


def test_bottom_turn_plan_leaves_at_the_first_target(plans):
    f = plans["GOOGL"]["trade_plan"]["flat"]
    assert "178.74" in f["at_target"] and "到了就在这里走" in f["at_target"]


@pytest.fixture(scope="module")
def qqq_crash() -> dict:
    """QQQ 2026-11-20（收 608.45）：加速下跌，现价上方 0.02% 就是 3 月那轮下跌留下的 20/60/120 汇聚（608.58）。"""
    return dma.analyze(load_fixture("QQQ", "2026-11-20"), "QQQ", "fixture")


def test_holding_in_a_downtrend_finds_no_target_before_the_20_line_turns_up(qqq_crash):
    """P25 是下降趋势拐头向上才找上方的均线密集；没拐头时持仓按反弹到 EMA20 减仓，不给目标。"""
    h = qqq_crash["trade_plan"]["holding"]
    assert qqq_crash["trade_plan"]["key"] == "加速下跌"
    assert h["targets"] == [] and h["at_target"] is None
    assert any("阻力位" in n and "P25" in n for n in h["notes"])
    assert not any("算不出" in n for n in h["notes"])


def test_flat_plan_skips_the_zone_the_rally_to_the_october_high_went_through(qqq_crash):
    """9 月的 20/60 密集（713.52）在本轮下跌开始之前：之后收盘到过 759（10-06 高点 762.86），它已经被冲过去了。
    第一目标是本轮下跌里没补的缺口（10-29，718.07）。"""
    f = qqq_crash["trade_plan"]["flat"]
    assert f["entry"]["price"] == pytest.approx(712.20, abs=0.01)
    assert f["stop"]["price"] == pytest.approx(674.24, abs=0.01)
    assert [(t["kind"], round(t["price"], 2), t["date"]) for t in f["targets"]] == [("缺口", 718.07, "2026-10-29")]
    assert f["rr"] == pytest.approx(0.155, abs=0.001) and f["rr_verdict"] == "不做"
    assert "718.07" in f["at_target"]


def test_reward_risk_in_the_play_text_has_two_decimals():
    """0.155 写成 0.2:1 会丢精度。"""
    f = tp.TradePlan(tp.Entry(10.0, "按收盘进", "P12"), tp.Stop(9.0, "止损", "P23", "视频"),
                     [tp.Target(10.155, "缺口", "P25", "视频", "2024-01-02")], 0.155, "不做",
                     {"target_for_min": 13.0, "stop_for_min": 9.95}, 10.0, None)
    holding = tp.TradePlan(None, None, [], None, None, None, None, None)
    assert "盈亏比 0.16:1" not in tp.verdict_line(tp.PlanSet("稳定上涨", f, holding))
    assert "盈亏比 0.15:1，不到 3:1，不做（P24）" in tp.verdict_line(tp.PlanSet("稳定上涨", f, holding))


def test_qqq_far_trigger_keeps_the_backtest_fields_and_adds_the_projection(qqq_crash):
    """QQQ 2026-11-20：明天扣 10-26 的 712.20，按收盘持平推演最早第 9 个交易日、站上 EMA20 674.24 才一起拐头。
    进场、止损、盈亏比、不做照旧留在 JSON 里（回测读这几个），显示改读 far。"""
    f = qqq_crash["trade_plan"]["flat"]
    assert f["entry"]["price"] == pytest.approx(712.20, abs=0.01)
    assert f["rr"] == pytest.approx(0.155, abs=0.001) and f["rr_verdict"] == "不做"
    far = f["entry"]["far"]
    assert far["level"] == pytest.approx(674.24, abs=0.01) and far["day"] == 9 and far["days"] == 10
    assert "最早约 9 个交易日后、收盘站上 674.24 才会一起拐头；明天要拐头得站上 712.20" in f["entry"]["condition"]


def test_qqq_far_trigger_text_says_recompute_instead_of_no_trade(qqq_crash):
    text = qqq_crash["play"]["text"]
    assert "不做（P24）" not in text and "触发价离现价还远，盈亏比到时重算（P24）" in text
    lines = [x for x in dma.plan_lines(qqq_crash["trade_plan"]) if x.startswith("- 空仓")]
    assert "盈亏比：触发价离现价还远，到时重算" in lines[0] and "不做" not in lines[0]


def test_qqq_far_trigger_does_not_mark_p24_met(qqq_crash):
    """P24 满足读作"不做"：触发价离现价还远时不判满足，也就没有规则让位给它（ADR 0026 后续）。按明天算的数留在依据里。"""
    p24 = next(r for r in qqq_crash["rules"] if r["id"] == "P24")
    assert p24["status"] == "不满足"
    assert p24["basis"].startswith("触发价离现价还远，到时重算") and "0.15:1" in p24["basis"]
    assert not any(r["yields_to"] == "P24" for r in qqq_crash["rules"])


def test_qqq_far_trigger_shares_say_recompute_but_keep_the_json(qqq_crash):
    """股数按明天的触发价算，和盈亏比一样是假设数：显示写到时重算，JSON 照旧（263 = 1 万 ÷ (712.20 − 674.24)）。"""
    assert qqq_crash["trade_plan"]["flat"]["size"]["per_10k"] == 263
    lines = [x for x in dma.plan_lines(qqq_crash["trade_plan"]) if x.startswith("- 空仓")]
    assert "股数：触发价离现价还远，到时重算" in lines[0] and "263" not in lines[0]
    a6 = next(r for r in qqq_crash["rules"] if r["id"] == "A6")
    assert a6["basis"].startswith("触发价离现价还远，到时重算") and "263" in a6["basis"]


def test_trigger_not_far_keeps_the_no_trade_text(plans):
    f = plans["SPY"]["trade_plan"]["flat"]
    assert f["entry"]["far"] is None
    assert "不做（P24）" in plans["SPY"]["play"]["text"]


def test_plan_without_targets_has_no_at_target_line(plans):
    assert plans["TSLA"]["trade_plan"]["flat"]["at_target"] is None


def test_account_setting_turns_into_shares():
    a = dma.analyze(load_fixture("GOOGL", "2025-04-08"), "GOOGL", "fixture", sizing=tp.Sizing(account=100_000))
    z = a["trade_plan"]["flat"]["size"]
    assert z["risk_amount"] == 1000 and z["shares"] == 114   # 1000 ÷ 8.74 = 114.35


def test_plan_rules_read_the_plan(plans):
    st = {r["id"]: r for r in plans["SPY"]["rules"]}
    assert st["P24"]["status"] == "满足" and st["P25"]["status"] == "满足" and st["P23"]["status"] == "满足"
    assert st["P22"]["status"] == "不满足" and st["A6"]["status"] == "满足"
