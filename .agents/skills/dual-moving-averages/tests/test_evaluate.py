"""评估：超额收益、区块自助法、同在场时间随机持有、MAR、判定和门槛文件都用合成数据手算核对；
轻量路径等于完整分析；决定点不用之后的行情。"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from conftest import FIXTURES, SCRIPTS
import backtest as bt
import evalstats as es
import evaluate as ev
import trades as tr

CONFIG = SCRIPTS.parent / "references" / "evaluation.toml"
CFG = es.load_config(CONFIG)
BC = {**CFG["bootstrap"], "reps": 4000}


# ---------- 门槛文件 ----------

def test_committed_config_loads():
    assert CFG["H1"]["min_meaningful"] == 0.01 and CFG["H3"]["ticker_share"] == 0.7


@pytest.mark.parametrize("edit,msg", [
    (lambda s: s.replace("min_rate = 0.9 ", "", 1), "[H4] 缺 min_rate"),
    (lambda s: s.replace("horizon = 20\nbull", "horizon = \"20\"\nbull", 1), "[H1].horizon"),
    (lambda s: s.replace("[H6]", "[H6]\ntypo = 1", 1), "不认识的键"),
    (lambda s: s.replace("ticker_share = 0.7", "ticker_share = 70", 1), "H3.ticker_share 要在 (0, 1]"),
    (lambda s: s.replace("[verdict]", "[verdict", 1), "TOML 语法错误"),
    (lambda s: s.replace("[bootstrap]", "[bootstrapp]", 1), "缺 [bootstrap]"),
])
def test_bad_config_fails_loudly(tmp_path, edit, msg):
    bad = tmp_path / "bad.toml"
    bad.write_text(edit(CONFIG.read_text(encoding="utf-8")), encoding="utf-8")
    with pytest.raises(es.ConfigError, match=msg.replace("[", r"\[").replace("(", r"\(").replace(")", r"\)")):
        es.load_config(bad)


# ---------- 超额收益、区块自助法 ----------

def test_excess_subtracts_each_tickers_own_mean():
    got = es.excess([0.10, 0.30, -0.05, 0.05], ["A", "A", "B", "B"])
    assert got == pytest.approx([-0.10, 0.10, -0.05, 0.05])


def test_block_ids_follow_trading_calendar_position():
    cal = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"]
    assert list(es.block_ids(["2024-01-02", "2024-01-04", "2024-01-08"], cal, 2)) == [0, 1, 2]


def test_block_bootstrap_resamples_whole_blocks_hand_computed():
    # 两块：块 0 全是 1，块 1 全是 3。整块重抽两次：均值只能是 1、2、3（概率 1/4、1/2、1/4），5% / 95% 分位就是 1 和 3
    e = es.mean_est([1, 1, 3, 3], [0, 0, 1, 1], BC)
    assert (e.point, e.lo, e.hi, e.n, e.blocks) == (2.0, 1.0, 3.0, 4, 2)


def test_points_in_one_block_move_together_so_interval_is_wider():
    vals = [0.0] * 20 + [1.0] * 20
    blocked = es.mean_est(vals, [0] * 20 + [1] * 20, BC)
    iid = es.mean_est(vals, list(range(40)), BC)
    assert (blocked.lo, blocked.hi) == (0.0, 1.0)
    assert iid.hi - iid.lo < 0.4


def test_diff_uses_the_same_resample_for_both_groups():
    # 两组在同一块里一起动（差恒为 1）：共用重抽时区间退化成一个点
    e = es.diff_est([2, 5], [0, 1], [1, 4], [0, 1], BC)
    assert (e.point, e.lo, e.hi) == (1.0, 1.0, 1.0)


def test_forward_open_matches_trades_forward():
    px = pd.DataFrame({"Open": [10, 11, 12, 14, 13, 15.0], "Close": 1.0}, index=pd.bdate_range("2024-01-01", periods=6))
    got = ev.forward_open(px["Open"].to_numpy(), 2)
    want = [tr.forward(px, i, 2) for i in range(6)]
    assert [None if np.isnan(g) else g for g in got] == pytest.approx(want)


# ---------- 资金曲线、MAR、随机持有 ----------

PX = pd.DataFrame({"Open": [10, 11, 12, 13, 14, 15, 16, 17, 16, 15.0],
                   "Close": [10.5, 11.5, 12.5, 12.0, 13.0, 14.5, 16.5, 17.5, 15.5, 15.2]},
                  index=pd.bdate_range("2024-01-01", periods=10))
UP = np.array([0, 1, 1, 0, 0, 1, 1, 1, 1, 1], dtype=bool)   # 第 i 天收盘后的方向


def test_mask_strategy_equals_trades_simulate_and_curve():
    """照方向持有：held[k] = 前一天的方向。和 trades.simulate + trades.curve 逐日相同，包括未平仓的最后一笔。"""
    start = 0
    ts = tr.simulate("X", PX, start, lambda i: tr.Signal("s", "R", False) if UP[i] else None,
                     lambda i, _: None if UP[i] else "走")
    held = UP[start:len(PX) - 1]
    assert list(es.held_from_trades(ts, start, len(PX) - 1)) == list(held)
    o, c = PX["Open"].to_numpy(), PX["Close"].to_numpy()
    mine = es.equity(o, c, held, start, tr.COST)
    assert mine == pytest.approx(tr.curve(PX, ts, start).to_numpy())
    assert es.max_drawdown(mine) == pytest.approx(tr.max_drawdown(tr.curve(PX, ts, start)))


def test_mar_hand_computed():
    eq = np.array([1.1, 0.88, 1.21])
    # 一年 3 天：年化 = 21%；回撤 = 0.88 / 1.1 − 1 = −20%
    assert es.mar(eq, days_per_year=3) == pytest.approx(0.21 / 0.2)
    assert np.isnan(es.mar(np.array([1.0, 1.1, 1.2])))


def runs(mask: np.ndarray) -> tuple[list[int], list[int]]:
    e = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(int), [0]])))
    starts, ends = e[::2], e[1::2]
    return sorted((ends - starts).tolist()), (starts[1:] - ends[:-1]).tolist()


def test_random_holding_keeps_exposure_and_trade_lengths():
    held = np.array([0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0], dtype=bool)
    rng = np.random.default_rng(3)
    seen = set()
    for _ in range(200):
        r = es.random_held(held, rng)
        lengths, gaps = runs(r)
        assert len(r) == len(held) and r.sum() == held.sum()
        assert lengths == runs(held)[0]                   # 同样几笔、每笔同样长
        assert min(gaps) >= 1                             # 两笔之间至少空一天（和逐日决定一样）
        seen.add(r.tobytes())
    assert len(seen) > 50                                 # 位置真的随机


def test_random_holding_is_seeded():
    held = UP[:9]
    o, c = PX["Open"].to_numpy(), PX["Close"].to_numpy()
    a = es.vs_random(o, c, held, 0, tr.COST, 50, 1, 0.8)
    b = es.vs_random(o, c, held, 0, tr.COST, 50, 1, 0.8)
    assert a == b


def test_never_in_market_ties_with_random():
    o, c = PX["Open"].to_numpy(), PX["Close"].to_numpy()
    r = es.vs_random(o, c, np.zeros(9, dtype=bool), 0, tr.COST, 20, 1, 0.8)
    assert (r.mdd, r.pctl_better, r.passed) == (0.0, 0.5, False)


# ---------- 判定（门槛读 evaluation.toml） ----------

def est(point, lo, hi, n=500, blocks=40):
    return es.Est(point, lo, hi, n, blocks)


GOOD = est(0.02, 0.005, 0.035)
HALVES = [est(0.01, -0.01, 0.03), est(0.03, 0.0, 0.05)]


def v(dev=GOOD, halves=HALVES, a=GOOD, bc=GOOD, holdout=None, sign=1, **kw):
    return es.verdict_effect(sign, dev, halves, a, bc, holdout, CFG["H1"]["min_meaningful"],
                             CFG["verdict"]["holdout_min_ratio"], **kw)


def test_verdict_useful_needs_holdout_at_least_half_of_dev():
    assert v() == es.DEV_PASSED
    assert v(holdout=est(0.011, -0.01, 0.03)) == es.USEFUL          # 区间可以跨 0，点估计 ≥ 一半
    assert v(holdout=est(0.009, 0.001, 0.02)) == es.UNSURE          # 不到一半
    assert v(holdout=est(-0.01, -0.02, 0.0)) == es.UNSURE


def test_verdict_useless_needs_interval_across_zero_and_small_point():
    assert v(dev=est(0.004, -0.01, 0.02)) == es.USELESS              # 小于 1 个百分点
    assert v(dev=est(0.015, -0.01, 0.04)) == es.UNSURE               # 跨 0，但不小
    assert v(dev=est(-0.02, -0.03, -0.01)) == es.UNSURE              # 方向反了


def test_verdict_halves_groups_and_sample():
    assert v(halves=[est(0.01, 0, 0.02), est(-0.001, -0.02, 0.02)]) == es.UNSURE
    assert v(bc=est(-0.01, -0.02, 0.0)) == "只在 A 组成立"
    assert v(a=est(-0.01, -0.02, 0.0)) == "只在 B+C 组成立"
    assert v(sample_ok=False) == es.FEW
    assert v(extra_ok=False) == es.UNSURE


def test_verdict_negative_claim_h6():
    neg = est(-0.02, -0.035, -0.005)
    assert v(dev=neg, halves=[est(-0.01, -0.03, 0.01)] * 2, a=neg, bc=neg, sign=-1) == es.DEV_PASSED
    assert v(dev=GOOD, sign=-1) == es.UNSURE


def hold(passed: bool, pctl: float = 0.9, edge: float = 0.2) -> es.HoldResult:
    return es.HoldResult(-0.2, 0.5 + edge, 0.5, pctl, -0.3, 0.5, passed)


def h3v(dev, halves=None, a=None, bc=None, holdout=None):
    s = es.summarize_h3
    return es.verdict_h3(s(dev), [s(x) for x in (halves or [dev, dev])], s(a or dev), s(bc or dev),
                         s(holdout) if holdout else None, CFG["H3"]["ticker_share"], CFG["H3"]["min_tickers"])


def test_verdict_h3_share_threshold_and_direction():
    pass7 = [hold(True)] * 7 + [hold(False)] * 3                     # 70% 通过：刚好够
    assert h3v(pass7) == es.DEV_PASSED
    assert h3v(pass7, holdout=[hold(False, 0.6, 0.1)] * 10) == es.USEFUL
    assert h3v(pass7, holdout=[hold(False, 0.4, 0.1)] * 10) == es.UNSURE
    six = [hold(True)] * 6 + [hold(False)] * 4
    assert h3v(six) == es.UNSURE                                     # 60%，方向还对
    assert h3v([hold(False, 0.3, -0.1)] * 10) == es.USELESS          # 随机持有的中位数就比它好
    assert h3v(pass7, bc=[hold(False, 0.3, -0.1)] * 10) == "只在 A 组成立"
    assert h3v(pass7[:5]) == es.FEW


# ---------- H4、H5 的口径 ----------

def test_inevitable_means_flat_price_makes_it_happen():
    recs = {"X": [{"d": "2024-01-02", "solves": [
        ["拐头向下", 20, None, "MA", True, 10, "有临界价位", 12.0, "以下", True],      # 持平就拐，要涨 12% 才能避免
        ["拐头向下", 60, None, "MA", True, 10, "有临界价位", -8.0, "以下", False],     # 要跌 8% 才拐：不是"不可避免"
        ["双双跌破", 20, 60, "MA", False, 10, "有临界价位", 2.0, "以上", True],        # 求不跌破：要涨 2% 才能避免
        ["拐头向上", 20, None, "MA", True, 30, "任何价位都成立", None, None, True],
        ["拐头向上", 20, None, "MA", True, 30, "有临界价位", 1.0, "以上", None],       # 之后行情不够 K 天：不算
    ]}]}
    t = ev.event_table(recs)
    assert t["inevitable"].tolist() == [True, False, True, False]
    assert t["x"].tolist()[:3] == [12.0, 8.0, 2.0]
    assert t["key"].tolist()[:2] == ["拐头向下20/0MAK10", "拐头向下60/0MAK10"]   # 没有慢线的事件也有键


def rec(k: int, typ: str | None, hi=None, lo=None, w="多头") -> dict:
    return {"i": k, "d": str(pd.Timestamp("2024-01-01") + pd.Timedelta(days=k))[:10], "type": typ,
            "box_high": hi, "box_low": lo, "w_ma": w, "w_ema": w}


def test_range_breakout_uses_box_known_the_day_before():
    c = {**CFG["H5"], "merge_gap": 1, "max_wait": 3}
    recs = [rec(0, "横盘", 100, 90), rec(1, "横盘", 100, 90), rec(2, None), rec(3, "横盘", 101, 90, "空头"),
            rec(4, "稳定上涨"), rec(5, "稳定上涨")]
    close = np.array([95, 102, 96, 103.5, 104.1, 110])
    got = ev.episodes(recs, close, c)
    # 第 1 天 102 < 100 × 1.03；第 3 天箱体还是 100（第 3 天的箱体当天才知道），103.5 > 103 → 向上突破，周线看第 2 天
    assert got == [{"date": recs[3]["d"], "start": recs[0]["d"], "up": True, "weekly": "多头"}]


def test_range_without_breakout_within_wait_is_dropped():
    c = {**CFG["H5"], "merge_gap": 0, "max_wait": 1}
    recs = [rec(0, "横盘", 100, 90), rec(1, None), rec(2, None), rec(3, None)]
    assert ev.episodes(recs, np.array([95, 96, 97, 120.0]), c) == []


# ---------- 轻量路径、缓存、不偷看未来 ----------

@pytest.mark.parametrize("ticker,date", [("SPY", "2022-06-15"), ("SPY", "2023-03-13"), ("TSLA", "2021-04-14"),
                                         ("GOOGL", "2024-08-05"), ("AAPL", "2021-05-03")])
def test_light_path_equals_full_analysis(ticker, date):
    px = bt.load(FIXTURES / f"{ticker}.csv")
    i = px.index.get_loc(pd.Timestamp(date))
    a = bt.analyze_on(px, i, ticker)
    assert ev.light(bt.cut_at(px, i)) == ev.regime_fields(a["regime"], a["play"]["key"], a["weekly"])


def test_cached_record_survives_json_and_ignores_later_prices():
    px = bt.load(FIXTURES / "SPY.csv")
    i = px.index.get_loc(pd.Timestamp("2023-03-13"))
    r = ev.analyze_day(px, i, "SPY", True)
    assert json.loads(json.dumps(r, ensure_ascii=False)) == r
    later = px.copy()
    later.iloc[i + 1:] = later.iloc[i + 1:] * 3
    s = ev.analyze_day(later, i, "SPY", True)
    assert {k: s[k] for k in r if k != "solves"} == {k: r[k] for k in r if k != "solves"}
    assert [x[:9] for x in s["solves"]] == [x[:9] for x in r["solves"]]   # 只有"之后发没发生"跟着行情变


def test_daily_cache_reruns_only_when_inputs_change(tmp_path):
    """缓存读回来和算出来一样；行情文件变了指纹就变。"""
    data = tmp_path / "data"
    data.mkdir()
    px = bt.load(FIXTURES / "SPY.csv").iloc[:900]
    raw = px.assign(**{"Adj Close": px["Close"]})
    raw.to_csv(data / "SPY.csv")
    cfg = {**CFG, "sample": {**CFG["sample"], "first_decision": "2022-06-01", "decision_every": 5}}
    first = ev.daily(["SPY"], data, tmp_path, cfg, 1)["SPY"]
    again = ev.daily(["SPY"], data, tmp_path, cfg, 1)["SPY"]
    assert first == again and first[0]["d"] >= "2022-06-01" and "lean" in first[0] and "lean" not in first[1]
    fp = ev.fingerprint(data / "SPY.csv", cfg)
    raw.iloc[:-1].to_csv(data / "SPY.csv")
    assert ev.fingerprint(data / "SPY.csv", cfg) != fp
