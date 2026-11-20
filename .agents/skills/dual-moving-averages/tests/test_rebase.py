"""盲测练习的前提：价格整体换算成指数、日期整周平移，分析结论一条都不变。

工作台的练习把真实行情乘一个系数（第一根收盘 = 100）、日期往后挪整数周再交给 dma_analyze，
用户就看不出是哪只票、哪一天。这里用真实行情片段验证：类型、阶段、打法、每条规则的状态、模糊判断都和原来一样，
价位按同一个系数缩放。

运行：uv run --with pytest --with pandas pytest .agents/skills/dual-moving-averages/tests -q
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import dma_analyze as dma  # noqa: E402
from indicators import add_indicators  # noqa: E402

CSV_HOURLY = {"available": False, "reason": "CSV 模式不取小时线"}
SHIFT = pd.Timedelta(weeks=9000)   # 约 172 年：和工作台一样落在 2190 年前后
PRICES = ["Open", "High", "Low", "Close"]


def load(name: str) -> pd.DataFrame:
    return pd.read_csv(FIXTURES / f"{name}.csv", parse_dates=["Date"]).set_index("Date").sort_index()


def rebase(df: pd.DataFrame) -> tuple[pd.DataFrame, float]:
    factor = 100 / float(df["Close"].iloc[0])
    out = df.copy()
    out[PRICES] = out[PRICES] * factor
    out["Volume"] = out["Volume"] * (1_000_000 / float(df["Volume"].mean()))
    out.index = out.index + SHIFT
    return out, factor


def run(cut: pd.DataFrame) -> dict:
    return dma.analyze(add_indicators(cut.copy()), "X", "CSV", cut, CSV_HOURLY)


def verdict(a: dict) -> dict:
    """不随价格水平和日期变的部分：工作台的结论、打法、清单都只读这些。"""
    r, m = a["regime"], a["ma200"]
    return {
        "regime": (r["name"], r["type"], r["stage"], r["transition"], r["depth"]),
        "play": a["play"]["key"],
        "rules": [(x["id"], x["status"], x["yields_to"]) for x in a["rules"]],
        "lean": (a["lean"]["label"], round(a["lean"]["score"], 9), a["lean"]["after"]["label"]),
        "arr": (a["arr_ma"], a["arr_ema"]),
        "steps": [(p["side"], p["current"] and p["current"]["progress"]) for p in a["steps"]],
        "drops": [(d["direction"], d["below"], d["first_low"]) for d in a["drops"]],
        "weekly": (a["weekly"].get("arr_ma"), a["weekly"].get("arr_ema")),
        # "死叉 2024-08-13（4 根前）"：日期跟着平移，叉的种类和几根前不变
        "crosses": [(c["pair"], c["ma"].split(" ")[0], c["ma"].split("（")[-1], c["ema"].split(" ")[0], c["ema"].split("（")[-1])
                    for c in a["crosses"]],
        # MA200 对照：站上 / 跌破、方向、几根前穿过、和双均线一不一致都不随价格水平变
        "ma200": (m["close_above"], m["direction"], m["stance"], m["dual_ma_stance"], m["agrees"], round(m["distance_pct"], 9),
                  m["last_cross"] and (m["last_cross"]["kind"], m["last_cross"]["bars_ago"])),
    }


CASES = [(name, back) for name in ("SPY", "AAPL", "TSLA", "GOOGL") for back in (0, 120, 300)]


@pytest.mark.parametrize(("name", "back"), CASES)
def test_rebasing_keeps_every_rule_and_play(name, back):
    df = load(name)
    moved, _ = rebase(df)
    end = len(df) - 1 - back
    assert verdict(run(moved.iloc[: end + 1])) == verdict(run(df.iloc[: end + 1]))


@pytest.mark.parametrize("name", ["SPY", "TSLA"])
def test_rebasing_scales_every_level_by_the_same_factor(name):
    df = load(name)
    moved, factor = rebase(df)
    a, b = run(df), run(moved)
    assert b["close"] == pytest.approx(a["close"] * factor)
    for x, y in zip(a["lines"], b["lines"]):
        assert y["ma"] == pytest.approx(x["ma"] * factor) and y["ema"] == pytest.approx(x["ema"] * factor)
    for x, y in zip(a["rules"], b["rules"]):
        assert y["levels"].keys() == x["levels"].keys()
        for k in (k for k in x["levels"] if k != "还差几根"):   # 唯一不是价位的一项：K 线根数
            assert y["levels"][k] == pytest.approx(x["levels"][k] * factor), (x["id"], k)
    assert b["bias20"] == pytest.approx(a["bias20"]) and b["spread_pct"] == pytest.approx(a["spread_pct"])
    assert b["ma200"]["value"] == pytest.approx(a["ma200"]["value"] * factor)


def test_chart_bars_flag_returns_the_whole_series(tmp_path):
    df = load("SPY").iloc[:400]
    csv = tmp_path / "p.csv"
    df.to_csv(csv)
    out = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(csv), "--json", "--chart-bars", "100000"],
                         capture_output=True, text=True, check=True)
    chart = json.loads(out.stdout)["chart"]
    assert len(chart["candles"]) == 400
    default = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(csv), "--json"],
                             capture_output=True, text=True, check=True)
    assert len(json.loads(default.stdout)["chart"]["candles"]) == 260
