"""筹码分布（volprofile.py）和 J45–J49、P39：分档的数是手算的。

最后一个测试守着和工作台的 JS 版（app/public/volprofile.js）的对照夹具：Python 改了算法，夹具跟着变，
app/test/volprofile.test.ts 就会拿 JS 的结果去对。改了算法时用 UPDATE_VOLPROFILE_FIXTURE=1 重新生成。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

from conftest import FIXTURES, load_fixture
import rules as rl
import volprofile as vp

CROSSCHECK = Path(__file__).resolve().parents[4] / "app/test/fixtures/volprofile-crosscheck.json"


# ---------- 分档（手算） ----------

def test_each_bar_spreads_its_volume_evenly_over_its_range():
    # 区间 10 ~ 14 分 4 档，每档 1 元。[10,12] 的 100 → 50、50；[10,11] 的 50 → 第 0 档；[12,14] 的 40 → 20、20
    edges, vols = vp.distribute([12, 11, 14], [10, 10, 12], [100, 50, 40], bins=4)
    assert edges == [10, 11, 12, 13, 14]
    assert vols == [100, 50, 20, 20]


def test_partial_overlap_is_proportional_to_length():
    # [10,14] 一档 1 元；[10.5, 12.5] 的 80 摊在 2 元上：第 0 档 0.5 元 → 20，第 1 档 → 40，第 2 档 0.5 元 → 20
    _, vols = vp.distribute([14, 12.5], [10, 10.5], [0, 80], bins=4)
    assert vols == pytest.approx([20, 40, 20, 0])


def test_flat_bar_puts_all_volume_in_its_bin_and_the_top_price_in_the_last_bin():
    _, vols = vp.distribute([14, 13.5, 14], [10, 13.5, 14], [0, 10, 7], bins=4)
    assert vols == [0, 0, 0, 17]


def test_one_price_window_has_no_mountain():
    edges, vols = vp.distribute([5, 5], [5, 5], [10, 10], bins=4)
    assert vols == [0, 0, 0, 0] and vp.find_mountains(edges, vols) == []


# ---------- 筹码山 ----------

def test_mountain_is_a_run_of_bins_at_or_above_the_average():
    # 平均 47.5：前两档在山里，山脚 10、山顶 12，占 150 / 190
    mts = vp.find_mountains([10, 11, 12, 13, 14], [100, 50, 20, 20])
    assert mts == [vp.Mountain(10, 12, 150, pytest.approx(150 / 190))]


def test_a_dip_below_average_splits_two_mountains():
    # 平均 50：第 0 档、第 2–3 档是两座山，第 1、4 档不够
    mts = vp.find_mountains([0, 1, 2, 3, 4, 5], [90, 10, 60, 80, 10])
    assert [(m.foot, m.top, m.volume) for m in mts] == [(0, 1, 90), (2, 4, 140)]


def test_bin_exactly_at_the_average_is_inside():
    mts = vp.find_mountains([0, 1, 2], [50, 50])
    assert [(m.foot, m.top) for m in mts] == [(0, 2)]


def test_plan_window_is_the_last_365_calendar_days():
    df = load_fixture("TSLA", "2021-05-14")
    p = vp.plan_profile(df)
    assert p.end == "2021-05-14" and p.start == "2020-05-14"
    assert p.bars == len(df[df.index >= pd.Timestamp("2020-05-14")])
    assert len(p.edges) == vp.PROFILE_BINS + 1 and sum(p.volumes) == pytest.approx(df["Volume"].iloc[-p.bars:].sum())


def test_no_volume_column_means_no_profile():
    df = load_fixture("TSLA", "2021-05-14").drop(columns=["Volume"])
    assert vp.plan_profile(df) is None
    assert vp.profile_json(None)["available"] is False


# ---------- 规则 J45–J49、P39（手搭的分布：三座山） ----------

PROFILE = vp.Profile("2025-01-02", "2025-12-31", 250, [100, 110, 120, 130, 140, 150, 160, 170], [0] * 7, [
    vp.Mountain(100, 110, 300, 0.3),   # 下方小山
    vp.Mountain(130, 150, 500, 0.5),   # 最大那座
    vp.Mountain(160, 170, 200, 0.2),
])


def ctx(close: float, prev: float | None = None, key: str = "稳定上涨") -> SimpleNamespace:
    df = pd.DataFrame({"Close": [prev if prev is not None else close, close]})
    return SimpleNamespace(profile=PROFILE, close=close, df=df, regime=SimpleNamespace(name="空头结构反弹中"),
                           plan=SimpleNamespace(key=key))


def test_j47_target_band_is_the_nearest_whole_mountain_above():
    r = rl.j47_bounce_target(ctx(115))
    assert r.status == rl.Status.MET and r.levels == {"山脚": 130, "山顶": 150}


def test_j47_inside_a_mountain_looks_at_the_next_one_up():
    assert rl.j47_bounce_target(ctx(140)).levels == {"山脚": 160, "山顶": 170}


def test_j47_unmet_with_nothing_above():
    assert rl.j47_bounce_target(ctx(175)).status == rl.Status.UNMET


def test_j48_close_above_the_largest_mountain_top_and_today_is_the_crossing():
    r = rl.j48_over_the_top(ctx(152, prev=149))
    assert r.status == rl.Status.MET and "今天刚翻过去" in r.basis


def test_j48_unmet_inside_the_largest_mountain():
    r = rl.j48_over_the_top(ctx(149))
    assert r.status == rl.Status.UNMET and "里" in r.basis


def test_j49_most_volume_above_is_climbing():
    # 115：上方 0.5 + 0.2，下方 0.3
    assert rl.j49_mountain_side(ctx(115)).status == rl.Status.MET


def test_j49_most_volume_below_is_the_easy_road():
    r = rl.j49_mountain_side(ctx(155))
    assert r.status == rl.Status.UNMET and "山路轻松" in r.basis


def test_p39_inside_a_mountain_follows_p25():
    assert "继续拿" in rl.p39_in_mountain(ctx(140, key="稳定上涨")).basis
    assert "在山里走" in rl.p39_in_mountain(ctx(140, key="空头结构反弹中")).basis
    assert rl.p39_in_mountain(ctx(155)).status == rl.Status.UNMET


def test_rules_without_volume_need_the_chart():
    c = SimpleNamespace(profile=None, close=1.0)
    assert rl.j45_profile(c).status == rl.Status.CHART


# ---------- 和 JS 版的对照夹具 ----------

def _cases() -> list[dict]:
    tsla = pd.read_csv(FIXTURES / "TSLA.csv", parse_dates=["Date"]).set_index("Date")
    spy = pd.read_csv(FIXTURES / "SPY.csv", parse_dates=["Date"]).set_index("Date")
    windows = {
        "TSLA 最近一年（到 2021-05-14）": vp.profile_window(tsla),
        "TSLA 2020 年初 60 根": tsla.loc["2020-01-02":].head(60),
        "SPY 2020 年 3 月急跌": spy.loc["2020-02-01":"2020-04-30"],
    }
    bars = {k: [{"high": float(r.High), "low": float(r.Low), "volume": float(r.Volume)} for r in w.itertuples()]
            for k, w in windows.items()}
    bars["一字线和顶上的那根"] = [{"high": 14, "low": 10, "volume": 0}, {"high": 13.5, "low": 13.5, "volume": 10},
                           {"high": 14, "low": 14, "volume": 7}, {"high": 12, "low": 10, "volume": 100}]
    out = []
    for name, b in bars.items():
        edges, vols = vp.distribute([x["high"] for x in b], [x["low"] for x in b], [x["volume"] for x in b])
        mts = [vars(m) for m in vp.find_mountains(edges, vols)]
        out.append({"name": name, "bars": b, "edges": edges, "volumes": vols, "mountains": mts})
    return out


def test_js_crosscheck_fixture_matches_python():
    want = {"bins": vp.PROFILE_BINS, "edge": vp.PROFILE_EDGE, "cases": _cases()}
    if os.environ.get("UPDATE_VOLPROFILE_FIXTURE"):
        CROSSCHECK.write_text(json.dumps(want, ensure_ascii=False) + "\n")
    assert json.loads(CROSSCHECK.read_text()) == want
