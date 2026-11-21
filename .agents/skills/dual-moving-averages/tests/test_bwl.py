"""黑绿线（P40–P45）：只在稳定上涨、稳定下跌里判，只认着色插件的颜色；交易计划不因它改变。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import replace

import pandas as pd
import pytest

from conftest import FIXTURES, SCRIPTS, load_fixture
import dma_analyze as dma
import regime as rg
import rules as rl
from regime import TrendType
from structure import find_structure
from tones import BUILTIN, ToneSource
from weekly import weekly_json

FAKE = ToneSource(key="plugin", name="假规则：按日期单双", legend=[])
IDS = rl.BWL_IDS


def base_ctx() -> rl.Ctx:
    """SPY 2024-04-19（稳定上涨·回撤中）的上下文，颜色和类型由各个测试换掉。"""
    df = load_fixture("SPY", "2024-04-19")
    bias = df["BIAS20"].dropna()
    structure = find_structure(df)
    regime, p20 = rg.classify(df, structure, float((bias <= df["BIAS20"].iloc[-1]).mean()))
    return rl.Ctx(df=df, regime=regime, p20=p20, p60=rg.pair_progress(df, 60, 120), structure=structure,
                  weekly=weekly_json(df))


BASE = base_ctx()


def ctx(colors: str, *, arrangement: str = "多头", type_: TrendType | None = TrendType.STEADY_UP,
        source: ToneSource = FAKE) -> rl.Ctx:
    """colors 是最后几根的颜色（g 绿 / b 黑 / m 灰 / - 不上色），更早的都不上色；arrangement 改最后一根 20 线组对 60 线组。"""
    df = BASE.df.copy()
    ma60, ema60 = df["MA60"].iloc[-1], df["EMA60"].iloc[-1]
    shift = {"多头": (1.05, 1.05), "空头": (0.95, 0.95), "不一致": (1.05, 0.95)}[arrangement]
    df.iloc[-1, df.columns.get_loc("MA20")] = ma60 * shift[0]
    df.iloc[-1, df.columns.get_loc("EMA20")] = ema60 * shift[1]
    letters = {"g": "bull", "b": "bear", "m": "mixed", "-": None}
    tones = pd.Series([None] * (len(df) - len(colors)) + [letters[c] for c in colors], index=df.index, dtype=object)
    return replace(BASE, df=df, regime=replace(BASE.regime, type=type_), tones=tones, tone_source=source)


def results(c: rl.Ctx) -> dict[str, dict]:
    """只算这六条：换掉的类型和其余规则用的类型细节（横盘的箱体、加速的位置）对不上。"""
    out = {}
    for rid in IDS:
        r = rl.BY_ID[rid].evaluate(c)
        out[rid] = {"id": rid, "status": r.status.value, "basis": r.basis}
    return out


def met(c: rl.Ctx) -> set[str]:
    return {k for k, r in results(c).items() if r["status"] == "满足"}


# ---------- 判法 ----------

@pytest.mark.parametrize("arrangement,colors,want", [
    ("多头", "bgg", {"P40", "P45"}),     # 多头排列里绿：做多；稳定上涨里一直是绿
    ("多头", "ggb", {"P41"}),            # 多头排列里变黑：平仓
    ("空头", "ggb", {"P42"}),            # 空头排列里黑：不做多、离场
    ("空头", "bbg", {"P43", "P45"}),     # 空头排列里变绿：不做多（稳定上涨里仍是绿）
    ("多头", "ggm", {"P44"}),            # 灰：警报，不动手
    ("不一致", "bgg", {"P45"}),          # 20、60 线组排列不一致：P40–P43 都不满足
])
def test_arrangement_and_todays_color_decide_p40_to_p45(arrangement, colors, want):
    assert met(ctx(colors, arrangement=arrangement)) == want


def test_inconsistent_arrangement_says_so():
    r = results(ctx("g", arrangement="不一致"))
    for rid in ("P40", "P41", "P42", "P43"):
        assert r[rid]["status"] == "不满足" and "20、60 线组排列不一致" in r[rid]["basis"]


def test_p45_counts_how_many_bars_have_been_green():
    basis = results(ctx("bgggg"))["P45"]["basis"]
    assert "已连续绿 4 根" in basis and "没出现灰或黑之前不用关心市场" in basis


def test_p45_mirror_in_a_steady_downtrend_is_black():
    down = results(ctx("gbb", arrangement="空头", type_=TrendType.STEADY_DOWN))
    assert down["P45"]["status"] == "满足" and "已连续黑 2 根" in down["P45"]["basis"]
    assert results(ctx("bbg", arrangement="空头", type_=TrendType.STEADY_DOWN))["P45"]["status"] == "不满足"


def test_every_basis_names_the_colors_it_used():
    for r in results(ctx("ggb")).values():
        assert f"（颜色：{FAKE.name}）" in r["basis"]


def test_no_bar_color_today_needs_the_chart():
    assert {r["status"] for r in results(ctx("gg-")).values()} == {"需看图"}


def test_the_six_rules_never_yield_to_each_other():
    for colors, arr in (("bgg", "多头"), ("ggb", "空头"), ("ggm", "多头")):
        assert all(r["yields_to"] is None for r in rl.evaluate(ctx(colors, arrangement=arr)) if r["id"] in IDS)


# ---------- 适用范围、颜色来源 ----------

@pytest.mark.parametrize("type_,word,cite", [
    (TrendType.RANGE, "横盘", "视频 P 01:25「"),
    (TrendType.ACCEL_UP, "加速上涨", "视频 P 01:42「"),
    (TrendType.ACCEL_DOWN, "加速下跌", "视频 P 01:42「"),
])
def test_outside_steady_trends_the_rules_do_not_apply(type_, word, cite):
    for r in results(ctx("bgg", type_=type_)).values():
        assert r["status"] == "不满足" and f"黑绿线不适合{word}" in r["basis"] and cite in r["basis"]


def test_transitions_do_not_apply_and_cite_where_the_indicator_fits():
    c = ctx("bgg", type_=None)
    for r in results(c).values():
        assert r["status"] == "不满足" and f"黑绿线不适合{c.regime.name}" in r["basis"] and "视频 P 01:59「" in r["basis"]


@pytest.mark.parametrize("source", [BUILTIN, replace(BUILTIN, warning="插件出错")])
def test_builtin_colors_are_not_the_indicator_so_the_rules_need_the_chart(source):
    for r in results(ctx("bgg", source=source)).values():
        assert r["status"] == "需看图" and "自带着色不是黑绿线，配了着色插件才判" in r["basis"]
        assert f"（颜色：{BUILTIN.name}）" in r["basis"]


def test_builtin_outside_steady_trends_is_still_not_applicable():
    assert {r["status"] for r in results(ctx("bgg", type_=TrendType.RANGE, source=BUILTIN)).values()} == {"不满足"}


# ---------- 分析 JSON 的 bwl ----------

def bwl(c: rl.Ctx) -> dict:
    return rl.bwl_json(c.bwl, list(results(c).values()))


def test_the_cited_quotes_are_the_ones_rules_md_carries():
    """不适用时依据里的原话和 rules.md 黑绿线一节写的一样，check_doc_quotes.py 对字幕核的是 rules.md。"""
    text = (SCRIPTS.parent / "references" / "rules.md").read_text(encoding="utf-8")
    for cite in [*rl.BWL_UNFIT.values(), rl.BWL_FIT]:
        quote = re.search(r"视频 P \d\d:\d\d「[^」]+」", cite).group(0)
        assert quote in text, quote


def test_bwl_json_reads_out_the_judgement():
    b = bwl(ctx("bggg"))
    assert b == {"source": {"key": "plugin", "name": FAKE.name}, "applicable": True, "color": "绿", "arrangement": "多头",
                 "text": "多头排列里绿：做多 / 持有（P40）；已连续绿 3 根，没出现灰或黑之前不用关心（P45）"}


def test_bwl_json_when_it_cannot_judge_gives_the_reason():
    assert bwl(ctx("g", source=BUILTIN))["text"] == "自带着色不是黑绿线，配了着色插件才判"
    off = bwl(ctx("g", type_=TrendType.RANGE))
    assert not off["applicable"] and off["color"] is None and off["text"].startswith("黑绿线不适合横盘")


# ---------- 交易计划不变 ----------

FAKE_PLUGIN = '''
import pandas as pd

NAME = "假规则：按日期单双"
LEGEND = ["绿：日期是双数", "黑：日期是单数"]


def tones(df):
    return pd.Series(df.index.day, index=df.index).map(lambda d: "bull" if d % 2 == 0 else "bear")
'''


def analysis(csv: str, asof: str, plugin) -> dict:
    env = {**os.environ, "DMA_TONE_PLUGIN": str(plugin) if plugin else ""}
    out = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", csv, "--asof", asof, "--json"],
                         capture_output=True, text=True, check=True, env=env)
    return json.loads(out.stdout)["analysis"]


@pytest.mark.parametrize("ticker,asof", [("SPY", "2024-04-19"), ("SPY", "2022-06-15"), ("TSLA", "2021-04-14")])
def test_plugin_changes_only_the_bwl_reading_never_the_trade_plan(tmp_path, ticker, asof):
    plugin = tmp_path / "fake_tones.py"
    plugin.write_text(FAKE_PLUGIN, encoding="utf-8")
    csv = str(FIXTURES / f"{ticker}.csv")
    plain, colored = analysis(csv, asof, None), analysis(csv, asof, plugin)
    assert colored["trade_plan"] == plain["trade_plan"]
    assert colored["play"] == plain["play"]
    others = lambda a: [r for r in a["rules"] if r["id"] not in IDS]  # noqa: E731
    assert others(colored) == others(plain)
    assert {k: v for k, v in colored.items() if k not in ("rules", "bwl")} == \
        {k: v for k, v in plain.items() if k not in ("rules", "bwl")}
    assert plain["bwl"]["source"]["key"] == "builtin" and colored["bwl"]["source"]["key"] == "plugin"


def test_spy_steady_uptrend_with_the_plugin_is_judged_and_without_it_needs_the_chart(tmp_path):
    plugin = tmp_path / "fake_tones.py"
    plugin.write_text(FAKE_PLUGIN, encoding="utf-8")
    csv = str(FIXTURES / "SPY.csv")
    colored = analysis(csv, "2024-04-19", plugin)          # 19 号单数：黑；多头排列 → P41
    assert colored["bwl"]["color"] == "黑" and colored["bwl"]["applicable"]
    assert next(r for r in colored["rules"] if r["id"] == "P41")["status"] == "满足"
    plain = analysis(csv, "2024-04-19", None)
    assert {r["status"] for r in plain["rules"] if r["id"] in IDS} == {"需看图"}


def test_analyze_reads_the_plugin_only_when_asked(tmp_path, monkeypatch):
    plugin = tmp_path / "fake_tones.py"
    plugin.write_text(FAKE_PLUGIN, encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(plugin))
    df = load_fixture("SPY", "2024-04-19")
    assert dma.analyze(df, "SPY", "fixture")["bwl"]["source"]["key"] == "builtin"
    assert dma.analyze(df, "SPY", "fixture", tone_plugin=True)["bwl"]["source"]["key"] == "plugin"
