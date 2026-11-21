"""顶底构造与波段：按 videoes/頂底構造.vtt 的定义，合成 K 线（只看最高价、最低价）。

每个例子开头三根上涨 K 线会先完成一个底部构造，顶部构造从第 4 根起找（两个构造不共用 K 线）。
"""
from __future__ import annotations

import json

import pandas as pd

from conftest import load_fixture
from structure import Side, State, find_structure, structure_json

RISE = [(10, 8), (11, 9), (12, 10)]


def bars(hl: list[tuple[float, float]]) -> pd.DataFrame:
    idx = pd.bdate_range("2024-01-02", periods=len(hl))
    return pd.DataFrame({"High": [h for h, _ in hl], "Low": [lo for _, lo in hl],
                         "Close": [(h + lo) / 2 for h, lo in hl]}, index=idx)


def day(df: pd.DataFrame, i: int) -> str:
    return str(df.index[i].date())


def test_simplest_top_is_three_bars():
    df = bars(RISE + [(14, 12), (13, 11), (12, 10.5)])
    top = find_structure(df).top
    assert (top.state, top.pivot_price, top.done_date) == (State.DONE, 14, day(df, 5))
    assert not top.extreme


def test_top_waits_for_the_lower_low_and_says_what_completes_it():
    df = bars(RISE + [(14, 12), (13, 11)])
    top = find_structure(df).top
    assert top.state == State.FORMING
    assert (top.complete_at, top.invalidation) == (11, 14)


def test_bars_inside_the_new_high_bar_are_ignored():
    inside = [(15, 12), (14.5, 11.5), (15.5, 13)]
    df = bars(RISE + [(16, 11)] + inside + [(14, 10.5)])
    top = find_structure(df).top
    # 被包含的三根不算更低的高点；打破包含的那根才是，它还要等一根更低的低点
    assert (top.state, top.lh_date, top.complete_at) == (State.FORMING, day(df, 7), 10.5)
    df = bars(RISE + [(16, 11)] + inside + [(14, 10.5), (13, 10)])
    assert find_structure(df).top.state == State.DONE


def test_extreme_top_needs_a_third_bar_to_confirm():
    # 第二根创新高、同时跌破前一根的低点
    df = bars(RISE + [(13, 11), (14, 10.5)])
    top = find_structure(df).top
    assert (top.state, top.extreme, top.complete_at) == (State.FORMING, True, 10.5)
    df = bars(RISE + [(13, 11), (14, 10.5), (13.5, 10)])
    top = find_structure(df).top
    assert (top.state, top.extreme, top.pivot_price) == (State.DONE, True, 14)


def test_without_the_engulfing_bar_two_more_bars_are_needed():
    df = bars(RISE + [(13, 11), (14, 11.5), (13.5, 10)])
    assert find_structure(df).top.state == State.FORMING


def test_higher_high_breaks_the_top():
    df = bars(RISE + [(14, 12), (13, 11), (12, 10.5), (15, 12)])
    s = find_structure(df)
    broken = [c for c in s.constructs if c.side == Side.TOP and c.state == State.BROKEN]
    assert [(c.pivot_price, c.broken_date) for c in broken] == [(14, day(df, 6))]
    assert (s.top.state, s.top.pivot_price) == (State.FORMING, 15)


def test_bottom_is_the_mirror():
    df = bars([(20, 18), (19, 17), (18, 16), (16, 14), (17, 15), (18, 15.5)])
    bottom = find_structure(df).bottom
    assert (bottom.side, bottom.state, bottom.pivot_price, bottom.invalidation) == (Side.BOTTOM, State.DONE, 14, 14)
    df = bars([(20, 18), (19, 17), (18, 16), (16, 14), (17, 15)])
    assert find_structure(df).bottom.complete_at == 17


def test_swing_joins_top_high_to_bottom_low_in_six_bars():
    df = bars(RISE + [(14, 12), (13, 11), (12, 10.5), (11.5, 9.5), (12, 10), (12.5, 10.2)])
    s = find_structure(df)
    assert [(p.kind, p.price) for p in s.pivots] == [("低", 8), ("高", 14), ("低", 9.5)]
    assert (s.last_high.price, s.last_low.price) == (14, 9.5)


M_TOP = RISE + [(14, 12), (13, 11), (12, 10.5),          # 顶部构造 A
                (11.5, 9.5), (12, 10), (12.5, 10.2),     # 底部构造 B（颈线 9.5）
                (13.8, 11.5), (13, 11), (12, 10.8),      # 顶部构造 C
                (11, 9.2), (10, 8.5)]                    # 收盘跌破颈线
TWO_B = RISE + [(14, 12), (13, 11), (12, 10.5),          # 顶部构造 A
                (11.5, 10),                              # 明显回撤，但没有底部构造
                (15, 11), (14, 10.8)]                    # 迅速创新高 C，随后收盘跌回 A 之下


def test_m_top_and_2b_are_told_apart():
    m = find_structure(bars(M_TOP)).patterns
    two_b = find_structure(bars(TWO_B)).patterns
    assert [(p.name, p.state, p.level) for p in m] == [("M 顶", "已形成", 9.5)]
    assert [(p.name, p.state, p.level) for p in two_b] == [("2B 顶", "已形成", 14)]


def test_formed_pattern_names_the_bar_whose_close_crossed_the_level():
    m_df, two_b_df = bars(M_TOP), bars(TWO_B)
    # M 顶：倒数第二根收盘 10.1 还在颈线 9.5 之上，最后一根 9.25 跌破；2B：C 之后那根收盘 12.4 跌回 A 的 14 之下
    assert find_structure(m_df).patterns[0].confirmed == day(m_df, len(M_TOP) - 1)
    assert find_structure(two_b_df).patterns[0].confirmed == day(two_b_df, len(TWO_B) - 1)


def test_m_top_before_the_neckline_breaks_is_pending():
    patterns = find_structure(bars(M_TOP[:-2])).patterns
    assert [(p.name, p.state, p.confirmed) for p in patterns] == [("M 顶", "待确认", None)]


def test_csv_without_high_low_reports_no_data():
    df = pd.DataFrame({"Close": [1.0, 2.0, 3.0]}, index=pd.bdate_range("2024-01-02", periods=3))
    assert structure_json(df) == {"available": False, "reason": "无数据"}


def test_structure_on_real_data_is_json_safe():
    out = structure_json(load_fixture("SPY", "2024-08-05"))
    json.dumps(out, ensure_ascii=False, allow_nan=False)
    assert out["available"] and out["pivots"]
    kinds = [p["kind"] for p in out["pivots"]]
    assert all(a != b for a, b in zip(kinds, kinds[1:]))  # 高低交替


def test_forming_construct_says_the_next_step_price_and_bars_left():
    # 只有新高那根：下一根最低价跌破 12 才出现更低的高点，之后还要一根才完成，最少两根
    top = find_structure(bars(RISE + [(14, 12)])).top
    assert (top.state, top.next_at, top.bars_left, top.complete_at) == (State.FORMING, 12, 2, None)
    # 有了更低的高点：下一步就是完成价，只差一根
    top = find_structure(bars(RISE + [(14, 12), (13, 11)])).top
    assert (top.next_at, top.bars_left, top.complete_at) == (11, 1, 11)


def test_bottom_next_step_on_spy_2024_04_19():
    # SPY 2024-04-19 新低那天：下一根最高价要过当天的最高价，底部构造才往前走
    df = load_fixture("SPY", "2024-04-19")
    b = find_structure(df).bottom
    assert (b.state, b.pivot_date, b.bars_left) == (State.FORMING, "2024-04-19", 2)
    assert b.next_at == float(df["High"].iloc[-1])
