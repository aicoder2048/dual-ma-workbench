"""K 线颜色从哪来（tones.py）：自带规则、着色插件的查找顺序、插件出错时退回自带规则、练习不读插件。

假插件的规则是随手编的（按日期单双上色），只用来认出"颜色确实是插件给的"。
"""
from __future__ import annotations

import itertools
import json
import os
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest
from conftest import FIXTURES, SCRIPTS, load_fixture

import dma_analyze as dma
import tones
from html_report import chart_data, render_html, weekly_chart
from weekly import weekly_frame

FAKE_NAME = "假规则：按日期单双"
FAKE_LEGEND = ["绿：日期是双数", "黑：日期是单数", "13 号不上色"]
FAKE_PLUGIN = f'''
import pandas as pd

NAME = "{FAKE_NAME}"
LEGEND = {FAKE_LEGEND!r}


def tones(df):
    day = pd.Series(df.index.day, index=df.index)
    return day.map(lambda d: None if d == 13 else "bull" if d % 2 == 0 else "bear")
'''


def fake_tone(time: str) -> str | None:
    day = int(time[-2:])
    return None if day == 13 else "bull" if day % 2 == 0 else "bear"


def candle_tones(chart: dict) -> list[str | None]:
    return [c.get("tone") for c in chart["candles"]]


def follows_fake_rule(chart: dict) -> bool:
    return candle_tones(chart) == [fake_tone(c["time"]) for c in chart["candles"]]


@pytest.fixture(scope="module")
def tsla() -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    df, history = load_fixture("TSLA", "2021-04-14"), load_fixture("TSLA", "2021-04-14", years=5)
    return df, history, dma.analyze(df, "TSLA", "fixture", history)


@pytest.fixture
def plugin(tmp_path, monkeypatch) -> Path:
    """DMA_TONE_PLUGIN 指向一个假插件。"""
    path = tmp_path / "fake_tones.py"
    path.write_text(FAKE_PLUGIN, encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(path))
    return path


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    """一个空的仓库根目录，环境变量没设：.env 和 private/tone_plugin.py 由各个测试自己放。"""
    monkeypatch.delenv("DMA_TONE_PLUGIN")
    monkeypatch.setattr(tones, "ROOT", tmp_path)
    return tmp_path


# ---------- 自带规则 ----------

# 搬进 tones.py 之前，html_report.bar_tones 在 TSLA 2021-04-14 这份夹具上逐根的结果（b 绿 / r 黑 / m 灰 / - 不上色，后面是连着几根）
BEFORE_MOVE = {
    "daily": "-20 m1 r4 m1 r5 m1 r1 b2 m1 b18 m2 r2 m1 r17 b11 r1 m8 r13 m6 b1 r1 b3 m1 r12 m2 b19 m2 b3 m1 b10 r14 m7 b1 r9 m1 r1 m1 "
             "r3 m2 r2 m1 b1 m5 b2 r19 m2 b3 r4 m1 r3 m1 r3 m1 r32 m5 b27 m5 r1 m1 r1 m1 r17 m2 r1 m3 b10 m2 b5 m6 b30 m1 b1 m9 b52 m4 "
             "r24 m3 b78 m5 r3 b18 m4 b7 r3 m3 b3 m1 b4 m1 b2 m2 r1 m3 r1 m1 r4 m1 r1 b1 m1 r6 b49 m1 b5 m2 r22 m1 r1 m1 r9 b4 m1 b1 m1 b3",
    "weekly": "-20 b18 m1 b2 m1 r4 m1 r2 b1 r3 m4 r1 m5 r11 m1 b1 m1 b1 r1 m2 r1 b2 m1 b1 m1 r1 m2 r4 b1 m1 b6 m2 b2 m8 r17 m2 r6 m1 b1 "
              "m1 b25 m3 b47 m1 b1 m4 b1",
}


def runs(tone: pd.Series) -> str:
    letters = [{"bull": "b", "bear": "r", "mixed": "m"}[t] if isinstance(t, str) else "-" for t in tone]
    return " ".join(f"{k}{len(list(g))}" for k, g in itertools.groupby(letters))


def test_builtin_rule_colors_every_bar_as_before_the_move(tsla):
    df, history, _ = tsla
    assert runs(tones.bar_tones(df)[0]) == BEFORE_MOVE["daily"]
    assert runs(tones.bar_tones(weekly_frame(history))[0]) == BEFORE_MOVE["weekly"]


def test_chart_names_the_builtin_rule_as_its_tone_source(tsla):
    df, history, a = tsla
    for chart in (chart_data(df, a), weekly_chart(history, a)):
        src = chart["tone_source"]
        assert (src["key"], src["name"], src["warning"]) == ("builtin", "破线拐头信号着色", None)
        assert src["legend"] and all(isinstance(line, str) and line for line in src["legend"])


# ---------- 着色插件 ----------

def test_plugin_from_env_var_colors_daily_and_weekly_charts(tsla, plugin):
    df, history, a = tsla
    for chart in (chart_data(df, a), weekly_chart(history, a)):
        assert follows_fake_rule(chart)
        assert chart["tone_source"] == {"key": "plugin", "name": FAKE_NAME, "legend": FAKE_LEGEND, "warning": None}


def test_private_tone_plugin_in_repo_root_is_used_when_env_var_is_unset(tsla, root):
    df, _, a = tsla
    (root / "private").mkdir()
    (root / "private" / "tone_plugin.py").write_text(FAKE_PLUGIN, encoding="utf-8")
    chart = chart_data(df, a)
    assert follows_fake_rule(chart) and chart["tone_source"]["key"] == "plugin"


def test_empty_env_var_turns_the_plugin_off_even_with_private_tone_plugin(tsla, root, monkeypatch):
    df, _, a = tsla
    builtin = chart_data(df, a)
    (root / "private").mkdir()
    (root / "private" / "tone_plugin.py").write_text(FAKE_PLUGIN, encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", "")
    assert chart_data(df, a) == builtin and builtin["tone_source"]["key"] == "builtin"


def test_dotenv_in_repo_root_names_the_plugin_relative_to_the_root(tsla, root):
    df, _, a = tsla
    (root / "mine").mkdir()
    (root / "mine" / "tones.py").write_text(FAKE_PLUGIN, encoding="utf-8")
    (root / ".env").write_text("POLYGON_API_KEY=x\nDMA_TONE_PLUGIN=mine/tones.py\n", encoding="utf-8")
    chart = chart_data(df, a)
    assert follows_fake_rule(chart) and chart["tone_source"]["key"] == "plugin"


def test_empty_value_in_dotenv_turns_the_plugin_off(tsla, root):
    df, _, a = tsla
    (root / "private").mkdir()
    (root / "private" / "tone_plugin.py").write_text(FAKE_PLUGIN, encoding="utf-8")
    (root / ".env").write_text("DMA_TONE_PLUGIN=\n", encoding="utf-8")
    assert chart_data(df, a)["tone_source"] == chart_data(df, a, builtin_only=True)["tone_source"]


def test_env_var_wins_over_dotenv(tsla, root, monkeypatch):
    df, _, a = tsla
    (root / "fake.py").write_text(FAKE_PLUGIN, encoding="utf-8")
    (root / ".env").write_text("DMA_TONE_PLUGIN=\n", encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(root / "fake.py"))
    assert chart_data(df, a)["tone_source"]["key"] == "plugin"


# ---------- 插件出错：退回自带规则，说明原因 ----------

BROKEN_PLUGINS = {
    "导入时抛异常": "raise RuntimeError('boom')",
    "语法错": "def tones(df):\n    return (",
    "缺 NAME": "LEGEND = []\ndef tones(df):\n    return None",
    "缺 tones": "NAME = 'x'\nLEGEND = []",
    "LEGEND 不是字符串列表": "NAME = 'x'\nLEGEND = 'abc'\ndef tones(df):\n    return None",
    "tones() 抛异常": "NAME = 'x'\nLEGEND = []\ndef tones(df):\n    return df['没有这一列']",
    "返回的不是 Series": "NAME = 'x'\nLEGEND = []\ndef tones(df):\n    return ['bull'] * len(df)",
    "长度不对": "import pandas as pd\nNAME = 'x'\nLEGEND = []\ndef tones(df):\n    return pd.Series('bull', index=df.index[:-1])",
    "索引不对": "import pandas as pd\nNAME = 'x'\nLEGEND = []\ndef tones(df):\n    return pd.Series('bull', index=range(len(df)))",
    "取值不对": "import pandas as pd\nNAME = 'x'\nLEGEND = []\ndef tones(df):\n    return pd.Series('green', index=df.index)",
}


def assert_fell_back(chart: dict, builtin: dict, capsys) -> None:
    src = chart["tone_source"]
    assert candle_tones(chart) == candle_tones(builtin)
    assert (src["key"], src["name"], src["legend"]) == ("builtin", builtin["tone_source"]["name"], builtin["tone_source"]["legend"])
    assert isinstance(src["warning"], str) and src["warning"]
    assert src["warning"] in capsys.readouterr().err


@pytest.mark.parametrize("source", BROKEN_PLUGINS.values(), ids=BROKEN_PLUGINS.keys())
def test_broken_plugin_falls_back_to_builtin_rule_with_a_warning(tsla, tmp_path, monkeypatch, capsys, source):
    df, _, a = tsla
    builtin = chart_data(df, a, builtin_only=True)
    path = tmp_path / "broken.py"
    path.write_text(source, encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(path))
    assert_fell_back(chart_data(df, a), builtin, capsys)


def test_missing_plugin_file_falls_back_to_builtin_rule_with_a_warning(tsla, tmp_path, monkeypatch, capsys):
    df, _, a = tsla
    builtin = chart_data(df, a, builtin_only=True)
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(tmp_path / "nowhere.py"))
    assert_fell_back(chart_data(df, a), builtin, capsys)


def test_plugin_cannot_change_the_frame_the_chart_is_drawn_from(tsla, tmp_path, monkeypatch):
    df, _, a = tsla
    builtin = chart_data(df, a, builtin_only=True)
    path = tmp_path / "greedy.py"
    path.write_text("import pandas as pd\nNAME = 'x'\nLEGEND = []\n"
                    "def tones(df):\n    df['Close'] = 0.0\n    df['MA20'] = 0.0\n    return pd.Series('mixed', index=df.index)",
                    encoding="utf-8")
    monkeypatch.setenv("DMA_TONE_PLUGIN", str(path))
    chart = chart_data(df, a)
    assert chart["tone_source"]["key"] == "plugin"
    assert chart["lines"] == builtin["lines"] and [c["close"] for c in chart["candles"]] == [c["close"] for c in builtin["candles"]]


# ---------- 只用自带规则：练习、识别题、网页报告 ----------

def test_builtin_only_ignores_the_plugin(tsla, plugin, monkeypatch):
    df, history, a = tsla
    with_plugin = chart_data(df, a, builtin_only=True), weekly_chart(history, a, builtin_only=True)
    monkeypatch.setenv("DMA_TONE_PLUGIN", "")
    assert with_plugin == (chart_data(df, a), weekly_chart(history, a))
    assert with_plugin[0]["tone_source"]["key"] == with_plugin[1]["tone_source"]["key"] == "builtin"


def test_html_report_does_not_embed_plugin_tones(tsla, plugin, monkeypatch):
    df, _, a = tsla
    with_plugin = render_html(a, df)
    monkeypatch.setenv("DMA_TONE_PLUGIN", "")
    assert FAKE_NAME not in with_plugin
    assert with_plugin.split("生成于")[0] == render_html(a, df).split("生成于")[0]


def run(script: str, *args: str, plugin: Path | None) -> dict:
    env = {**os.environ, "DMA_TONE_PLUGIN": str(plugin) if plugin else ""}
    out = subprocess.run([sys.executable, str(SCRIPTS / script), *args], capture_output=True, text=True, check=True, env=env)
    return json.loads(out.stdout)


CSV_ARGS = ("--csv", str(FIXTURES / "SPY.csv"), "--asof", "2024-04-19", "--json")


def test_dma_analyze_json_uses_the_plugin_unless_asked_for_builtin_tones(plugin):
    plain = run("dma_analyze.py", *CSV_ARGS, plugin=None)
    colored = run("dma_analyze.py", *CSV_ARGS, plugin=plugin)
    # 分析里只有黑绿线（P40–P45 和 bwl）跟着插件变，交易计划不变（test_bwl.py 逐字段比）
    assert colored["analysis"]["trade_plan"] == plain["analysis"]["trade_plan"]
    assert colored["analysis"]["bwl"]["source"]["name"] == FAKE_NAME
    for chart in (colored["chart"], colored["chart"]["weekly"]):
        assert follows_fake_rule(chart) and chart["tone_source"]["name"] == FAKE_NAME
    assert run("dma_analyze.py", *CSV_ARGS, "--builtin-tones", plugin=plugin) == plain
    assert plain["chart"]["tone_source"]["key"] == plain["chart"]["weekly"]["tone_source"]["key"] == "builtin"


def test_scan_never_reads_the_plugin(plugin):
    args = ("--csv", str(FIXTURES / "SPY.csv"), "--dates", "2024-04-19", "--jobs", "1")
    scanned = run("scan.py", *args, plugin=plugin)
    assert scanned == run("scan.py", *args, plugin=None)
    assert scanned["chart"]["tone_source"]["key"] == "builtin"
