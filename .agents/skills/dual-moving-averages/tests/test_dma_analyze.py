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
sys.path.insert(0, str(SCRIPTS))

import dma_analyze as dma  # noqa: E402


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
    a = json_out["analysis"]
    assert a["trend"] in dma.STRATEGY
    assert isinstance(a["lines"][0]["above"], bool)
    assert [d["period"] for d in a["drops"]] == list(dma.PERIODS)


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
    closes = [100 + i * 0.5 for i in range(200)] + [200 - i * 3 for i in range(30)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    row = a["lean"]
    assert a["lines"][1]["ma"] > a["lines"][2]["ma"]  # MA60 > MA120：确实"错位"
    assert row["label"] == "明显偏空"
    assert a["trend"] in ("健康下跌", "极度超卖")


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
    # TSLA 2021-04-14 的形状：长涨 → 急跌 → 强反弹。多数线已向上，但 20 线组仍在 60 线组下方。
    closes = [100 + i * 0.5 for i in range(250)] + [225 - i * 2 for i in range(30)] + [165 + i * 2 for i in range(18)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    lean = a["lean"]
    assert lean["up"] > lean["down"]
    assert lean["conflict"] == "反弹受压"
    assert "不买" in lean["play"]


def test_aligned_trend_has_no_conflict(rising):
    assert dma.analyze(rising, "TEST", "synthetic")["lean"]["conflict"] is None


def test_flip_levels_mark_thresholds_price_already_crossed():
    # 上涨后回落一点：偏多，但价格已在 EMA20 下方 → EMA20 那个门槛标为已越过
    closes = [100 + i * 0.5 for i in range(250)] + [225 - i * 1.5 for i in range(6)]
    a = dma.analyze(make_df(closes), "TEST", "synthetic")
    assert a["lean"]["score"] > 0
    ema20 = next(f for f in a["lean"]["flips"] if f["line"] == "EMA20")
    assert ema20["crossed"] == (a["close"] < a["lines"][0]["ema"])
    assert ema20["crossed"]
