"""dma_analyze.py 的确定性测试：合成价格，不联网。

运行：uv run --with pytest --with pandas pytest .agents/skills/dual-moving-averages/tests -q
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import dma_analyze as dma  # noqa: E402
import rules  # noqa: E402


def make_df(closes: list[float], volume: bool = True) -> pd.DataFrame:
    idx = pd.bdate_range("2024-01-02", periods=len(closes))
    df = pd.DataFrame({"Close": closes}, index=idx)
    if volume:
        df["Volume"] = [1_000_000 + (i % 7) * 10_000 for i in range(len(closes))]
    return dma.add_indicators(df)


@pytest.fixture
def rising() -> pd.DataFrame:
    return make_df([float(i) for i in range(1, 201)])


def test_drop_off_tomorrow_is_close_n_bars_back(rising):
    # close = 1..200；MA20 明天要扣的是倒数第 20 根 = 181
    assert dma.drop_off(rising, 20)["tomorrow"] == 181.0


def test_drop_off_flat_projection_matches_brute_force(rising):
    c = rising["Close"].iloc[-1]
    for n in dma.PERIODS:
        got = dma.drop_off(rising, n)["ma_flat_change_pct"]
        days = min(n, dma.PROJECT_DAYS)
        extended = pd.concat([rising["Close"], pd.Series([c] * days)], ignore_index=True)
        ma_after = extended.rolling(n).mean().iloc[-1]
        expected = (ma_after / rising[f"MA{n}"].iloc[-1] - 1) * 100
        assert got == pytest.approx(expected), n


def test_rising_series_is_bullish(rising):
    a = dma.analyze(rising, "TEST", "synthetic")
    assert a["arr_ma"] == "多头"
    assert all(d["direction"] == "上" for d in a["drops"])


def test_falling_series_is_bearish():
    a = dma.analyze(make_df([float(i) for i in range(300, 100, -1)]), "TEST", "synthetic")
    assert a["arr_ma"] == "空头"
    assert all(d["direction"] == "下" for d in a["drops"])


def _reject_nan(token: str):
    raise ValueError(f"JSON 里出现了 {token}")


@pytest.fixture
def json_out(tmp_path) -> dict:
    closes = [100 + 10 * math.sin(i / 9) + i * 0.1 for i in range(260)]
    csv = tmp_path / "prices.csv"
    df = pd.DataFrame({"Date": pd.bdate_range("2024-01-02", periods=len(closes)), "Close": closes,
                       "Volume": [1_000_000] * len(closes)})
    df.to_csv(csv, index=False)
    proc = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(csv), "--json"],
                          capture_output=True, text=True, check=True)
    return json.loads(proc.stdout, parse_constant=_reject_nan)


def test_json_has_analysis_and_chart(json_out):
    assert set(json_out) >= {"analysis", "chart"}
    assert set(json_out["chart"]) >= {"candles", "volume", "lines", "drops"}
    assert set(json_out["chart"]["lines"]) == {f"{k}{n}" for n in dma.PERIODS for k in ("MA", "EMA")}


def test_json_analysis_matches_markdown_numbers(json_out, tmp_path):
    # trend / strategy 换成了 regime（类型 × 阶段）和唯一的 play
    a = json_out["analysis"]
    assert a["play"]["key"] in rules.PLAY_KEYS
    assert a["regime"]["name"]
    assert isinstance(a["lines"][0]["above"], bool)
    assert [d["period"] for d in a["drops"]] == list(dma.PERIODS)


def test_json_adds_projection_structure_weekly(json_out):
    a = json_out["analysis"]
    assert {"hurdles", "scenarios", "solves"} <= set(a["projection"])
    # 这份 CSV 只有收盘价、约一年：构造无数据，周线不够 MA120
    assert a["structure"] == {"available": False, "reason": "无数据"}
    assert a["weekly"]["available"] is False


def test_drop_off_path_lists_future_deductions(rising):
    # 未来第 k 天扣的是倒数第 n-k+1 根；路径长度 = 推演天数，均值与 drop_off 一致
    d = dma.drop_off(rising, 20)
    assert len(d["path"]) == min(20, dma.PROJECT_DAYS)
    assert d["path"][0] == {"date": str(rising.index[-20].date()), "close": 181.0}
    assert sum(p["close"] for p in d["path"]) / len(d["path"]) == pytest.approx(d["mean"])


# ---------- 模糊判断（lean）----------

def test_rising_series_leans_clearly_bullish(rising):
    lean = dma.analyze(rising, "TEST", "synthetic")["lean"]
    assert lean["label"] == "明显偏多"
    assert (lean["up"], lean["down"]) == (6, 0)


def test_falling_series_leans_clearly_bearish():
    lean = dma.analyze(make_df([float(i) for i in range(300, 100, -1)]), "TEST", "synthetic")["lean"]
    assert lean["label"] == "明显偏空"


def test_small_misorder_does_not_hide_a_clear_downtrend():
    # 长期上涨后急跌：6 条线都向下、价格在所有线下方，但 MA60 仍略高于 MA120。
    # 精确规则会判"排列混乱"，模糊判断应当是明显偏空，趋势类型落在下跌一侧。
    # 改名：健康下跌 / 极度超卖 → 稳定下跌 / 加速下跌。这里 60/120 还没排好，是加速下跌的起点（J3、J8）。
    closes = [100 + i * 0.5 for i in range(200)] + [200 - i * 3 for i in range(30)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    row = a["lean"]
    assert a["lines"][1]["ma"] > a["lines"][2]["ma"]  # MA60 > MA120：确实"错位"
    assert row["label"] == "明显偏空"
    assert a["regime"]["type"] == "加速下跌"
    assert a["regime"]["accel"]["phase"] == "起点"


def test_flat_series_has_no_lean():
    closes = [100 + (1 if i % 2 else -1) for i in range(260)]
    lean = dma.analyze(make_df(closes), "TEST", "synthetic")["lean"]
    assert lean["label"] == "不明"


def test_flip_levels_name_what_would_change_a_bearish_read():
    a = dma.analyze(make_df([float(i) for i in range(300, 100, -1)]), "TEST", "synthetic")
    flips = {f["line"]: f["price"] for f in a["lean"]["flips"]}
    # 偏空时：收盘站上 EMA20（EMA20 先拐）、站上 MA20 明天的抵扣价（MA20 后拐）
    assert flips["EMA20"] == pytest.approx(a["lines"][0]["ema"])
    assert flips["MA20"] == pytest.approx(a["drops"][0]["tomorrow"])


def test_lean_after_projects_price_flat(rising):
    after = dma.analyze(rising, "TEST", "synthetic")["lean"]["after"]
    assert after["label"] in dma.LEAN_LABELS
    assert after["days"] == dma.PROJECT_DAYS


def test_bounce_under_the_60_group_is_flagged_not_bought():
    # 长涨 → 急跌 → 强反弹，20 线组仍在 60 线组下方。原来靠 lean.conflict（反弹受压）标出来；
    # 现在打架的状态归到 regime：60/120 定不出类型（这条合成序列 MA60、EMA60 方向不一致，是失序），
    # 打法是唯一的 play，不说买。真实的空头结构反弹中见 test_regime 的 TSLA 2021-04-14。
    closes = [100 + i * 0.5 for i in range(250)] + [225 - i * 2 for i in range(30)] + [165 + i * 2 for i in range(18)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    assert a["lean"]["up"] > a["lean"]["down"]
    assert a["lines"][0]["ma"] < a["lines"][1]["ma"] and a["lines"][0]["ema"] < a["lines"][1]["ema"]
    assert a["regime"]["type"] is None
    assert "不做" in a["play"]["text"] or "不买" in a["play"]["text"]


def test_aligned_trend_is_not_a_transition(rising):
    # lean.conflict 去掉了；顺畅的上涨应当有类型、没有过渡状态
    r = dma.analyze(rising, "TEST", "synthetic")["regime"]
    assert (r["type"], r["transition"]) == ("稳定上涨", None)


def test_flips_list_both_directions():
    # 原来只列一个方向、已越过的门槛标 crossed；现在两个方向都列：价位在现价上方是"站上转多"，下方是"跌破转空"
    closes = [100 + i * 0.5 for i in range(250)] + [225 - i * 1.5 for i in range(6)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    flips = {f["line"]: f for f in a["lean"]["flips"]}
    assert a["close"] < a["lines"][0]["ema"]
    assert flips["EMA20"]["toward"] == "多" and "站上" in flips["EMA20"]["text"]
    assert flips["EMA60"]["toward"] == "空" and "跌破" in flips["EMA60"]["text"]
    assert all((f["price"] > a["close"]) == (f["toward"] == "多") for f in flips.values())


# ---------- K 线着色（tone）----------
def _tones(df: pd.DataFrame) -> list[str | None]:
    from html_report import chart_data
    candles = chart_data(df, dma.analyze(df, "TEST", "synthetic"))["candles"]
    return [c.get("tone") for c in candles]


def test_rising_series_candles_are_bull(rising):
    assert set(_tones(rising)[-50:]) == {"bull"}


def test_falling_series_candles_are_bear():
    assert set(_tones(make_df([float(i) for i in range(300, 100, -1)]))[-50:]) == {"bear"}


def test_close_above_ma20_but_below_deduction_price_is_mixed():
    # 20 根前有一根 200 的尖峰，已出了 MA20 窗口：今天 101 在 MA20 上方，却低于抵扣价 200
    closes = [100.0] * 160
    closes[-21] = 200.0
    closes[-1] = 101.0
    assert _tones(make_df(closes))[-1] == "mixed"


def test_close_below_ma20_but_above_deduction_price_is_mixed():
    # 抵扣价 50，窗口里有 300 的尖峰把 MA20 抬到 110：今天 100 高于抵扣价，却在 MA20 下方
    closes = [100.0] * 160
    closes[-21] = 50.0
    closes[-11] = 300.0
    assert _tones(make_df(closes))[-1] == "mixed"


def test_bars_without_20_bars_of_history_have_no_tone(rising):
    tones = _tones(rising)  # 200 根全在图上
    assert tones[:20] == [None] * 20
    assert None not in tones[20:]


def test_csv_mode_cuts_like_live_fetch():
    """CSV 模式和按代码实时取数一样：日线分析只看最近 3 年，周线用最近 5 年，都截到 asof。"""
    daily, history, _ = dma.load_prices(None, str(FIXTURES / "GOOGL.csv"), "2024-08-05", None, "auto")
    end = pd.Timestamp("2024-08-05")
    assert daily.index[-1] == history.index[-1] == end
    assert daily.index[0] >= end - pd.DateOffset(years=3) > daily.index[0] - pd.Timedelta(days=7)
    assert history.index[0] >= end - pd.DateOffset(years=5) > history.index[0] - pd.Timedelta(days=7)


def test_csv_mode_without_asof_ends_at_the_last_row():
    daily, history, _ = dma.load_prices(None, str(FIXTURES / "TSLA.csv"), None, None, "auto")
    assert daily.index[-1] == history.index[-1] == pd.Timestamp("2021-05-14")
    assert daily.index[0] >= pd.Timestamp("2018-05-14")
