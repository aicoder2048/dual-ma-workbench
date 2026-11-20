"""规则层：rules.md 和脚本的编号一一对应；规则评估、唯一打法、规则清单。"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from conftest import load_fixture
import dma_analyze as dma
import rules

RULES_MD = Path(__file__).resolve().parents[1] / "references" / "rules.md"
ROW = re.compile(r"^\| ([AJP]\d+) \| (公理|判定|动作) \|.*\| ([^|]+) \|$")


def md_rules() -> dict[str, tuple[str, str]]:
    """rules.md 每条规则的 (种类, 由哪个计算判断)。"""
    out = {}
    for line in RULES_MD.read_text().splitlines():
        m = ROW.match(line)
        if m:
            assert m.group(1) not in out, f"rules.md 里 {m.group(1)} 重复"
            out[m.group(1)] = (m.group(2), m.group(3).strip())
    return out


def test_rule_ids_match_between_rules_md_and_script():
    assert set(md_rules()) == {r.id for r in rules.RULES}


def test_rule_kind_and_evaluator_match_rules_md():
    md = md_rules()
    for r in rules.RULES:
        kind, compute = md[r.id]
        assert kind == r.kind.value, r.id
        expected = "需看图" if r.evaluate is None else f"`rules.{r.evaluate.__name__}`"
        assert compute == expected, r.id


def test_every_threshold_in_json_is_listed_in_rules_md():
    text = RULES_MD.read_text()
    for name, (_, source) in dma.THRESHOLDS.items():
        assert f"`{name}`" in text, name
        assert source in ("视频", "校准值", "脚本自定")


@pytest.fixture(scope="module")
def spy() -> dict:
    return dma.analyze(load_fixture("SPY", "2024-04-19"), "SPY", "fixture")


@pytest.fixture(scope="module")
def tsla() -> dict:
    return dma.analyze(load_fixture("TSLA", "2021-04-14"), "TSLA", "fixture")


def status(a: dict, rid: str) -> str:
    return next(r["status"] for r in a["rules"] if r["id"] == rid)


def test_every_rule_has_a_result_and_uncomputable_ones_need_the_chart(spy):
    assert [r["id"] for r in spy["rules"]] == [r.id for r in rules.RULES]
    for r in spy["rules"]:
        assert r["status"] in ("满足", "不满足", "需看图")
        if rules.BY_ID[r["id"]].evaluate is None:
            assert r["status"] == "需看图"


def test_spy_pullback_first_two_conditions_met_construct_pending(spy):
    # 0.6：吃回撤前两个条件满足，底部构造和小时线待定
    assert (status(spy, "P10"), status(spy, "P11"), status(spy, "P12"), status(spy, "P13")) == \
        ("满足", "满足", "不满足", "需看图")
    p11 = next(r for r in spy["rules"] if r["id"] == "P11")
    assert p11["levels"]["MA120 30 天抵扣价最高"] == pytest.approx(460.20, abs=0.05)


def test_tsla_bounce_is_a_fake_move_and_not_a_buy(tsla):
    assert status(tsla, "J17") == "满足"     # 理顺要 +8.4%，距离很大
    assert status(tsla, "P17") == "满足"
    assert status(tsla, "P16") == "满足"
    j17 = next(r for r in tsla["rules"] if r["id"] == "J17")
    assert j17["levels"]["10 天内理顺"] == pytest.approx(264.51, abs=0.05)


def test_one_play_and_it_matches_the_regime(spy, tsla):
    # STRATEGY 和 LEAN_PLAY 合成一个出口：analysis 里只有 play，lean 里没有 play
    for a in (spy, tsla):
        assert "strategy" not in a and "trend" not in a and "play" not in a["lean"]
        assert set(a["play"]["rules"]) <= rules.BY_ID.keys()
    assert spy["play"]["key"] == "稳定上涨"
    assert tsla["play"]["key"] == "空头结构反弹中"
    assert "不买" in tsla["play"]["text"] and "加仓" not in tsla["play"]["text"]


@pytest.mark.parametrize(("ticker", "asof", "key"), [
    ("SPY", "2024-04-19", "稳定上涨"), ("SPY", "2024-08-05", "稳定上涨"),
    ("TSLA", "2021-04-14", "空头结构反弹中"), ("GOOGL", "2025-04-08", "加速下跌"),
])
def test_baseline_plays(ticker, asof, key):
    a = dma.analyze(load_fixture(ticker, asof), ticker, "fixture")
    assert a["play"]["key"] == key


def test_markdown_has_one_strategy_and_a_rule_list(tsla):
    md = dma.render_markdown(tsla)
    strategy = md.split("## 2) 定策略", 1)[1].split("## 3)", 1)[0]
    assert strategy.count("不买") == 1 and "持有" not in strategy
    rows = [line for line in md.split("## 4) 规则清单", 1)[1].splitlines() if re.match(r"^\| [AJP]\d+ ", line)]
    assert len(rows) == len(rules.RULES)


def test_lean_reads_the_type_lines(tsla, spy):
    # 模糊判断来自 MA60、MA120 的方向和收盘不变能保持几天（0.6：MA60 约第 24 天才扣到低于现价）
    ma60 = next(b for b in tsla["lean"]["basis"] if b["line"] == "MA60")
    assert (ma60["direction"], ma60["hold_days"]) == ("下", 23)
    ma120 = next(b for b in spy["lean"]["basis"] if b["line"] == "MA120")
    assert ma120["level"] == pytest.approx(460.20, abs=0.05)
    assert spy["lean"]["label"] in ("偏多", "明显偏多")


def test_tsla_second_chance_yields_to_bad_order(tsla):
    # P20 自己满足，但 P17（排列不合理不买）优先：规则清单要写出来，不然两条读起来互相矛盾
    p20 = next(r for r in tsla["rules"] if r["id"] == "P20")
    assert (p20["status"], p20["yields_to"]) == ("满足", "P17")
    assert next(r for r in tsla["rules"] if r["id"] == "P17")["yields_to"] is None
    assert "| P20 | 双线系统第 2 次机会 | 满足，P17 优先 |" in dma.render_markdown(tsla)


def test_cases_md_baselines_spy_deep_pullback_and_googl_turn_level():
    # cases.md 回放基准：SPY 2024-08-05 击穿 120 线组，MA120 30 天内会拐头，吃回撤② 不满足
    spy = dma.analyze(load_fixture("SPY", "2024-08-05"), "SPY", "fixture")
    assert status(spy, "P11") == "不满足"
    googl = dma.analyze(load_fixture("GOOGL", "2025-04-08"), "GOOGL", "fixture")
    turn = next(s for s in googl["projection"]["solves"] if s["event"] == "MA20 拐头向上" and s["days"] == 10)
    assert turn["level"] == pytest.approx(160.67, abs=0.05)
