"""规则层：rules.md 和脚本的编号一一对应；规则评估、唯一打法、规则清单。"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import pandas as pd
import pytest

from conftest import load_fixture
from indicators import add_indicators
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
    # 同一页上 10 天和 30 天两个理顺价位要一起给，读者才知道为什么差这么多：MA60 抵扣价第 24 天起才扣低值
    p17 = next(r for r in tsla["rules"] if r["id"] == "P17")
    assert p17["levels"]["10 天内理顺"] == pytest.approx(264.51, abs=0.05)
    assert p17["levels"]["30 天内理顺"] == pytest.approx(230.82, abs=0.05)
    assert "10 天内要持平在 264.51" in p17["basis"] and "30 天内要持平在 230.82" in p17["basis"]
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


# ---------- 吃回撤的先后顺序（视频 B 13:20「满足这两个条件之后」，第三点才是底部构造） ----------

def hourly(arr: str) -> dict:
    return {"available": True, "source": "合成", "bars": 200, "last": "2021-08-31 15:00", "close": 1.0,
            "lines": [{"period": n, "ma": 1.0, "ema": 1.0} for n in (20, 60, 120)], "arr_ma": arr, "arr_ema": arr}


@lru_cache
def pullback_days(down: int, drop: float, up: int, rise: float, mirror: bool = False) -> list[dict]:
    """400 根每天 +0.3% 的稳定上涨，跌 down 根（每根 −drop），再涨 up 根（每根 +rise）。返回回撤开始后每天的分析。

    mirror：价格取倒数，成了稳定下跌里的反弹，小时线给空头排列。"""
    closes = [100 * 1.003 ** i for i in range(400)]
    closes += [closes[-1] * (1 - drop) ** (i + 1) for i in range(down)]
    closes += [closes[-1] * (1 + rise) ** (i + 1) for i in range(up)]
    if mirror:
        closes = [10000 / c for c in closes]
    df = pd.DataFrame({"Open": closes, "High": [c * 1.005 for c in closes], "Low": [c * 0.995 for c in closes],
                       "Close": closes, "Volume": 1e6}, index=pd.bdate_range("2020-01-02", periods=len(closes)))
    df = add_indicators(df)
    h = hourly("空头" if mirror else "多头")
    return [dma.analyze(df.iloc[:k], "T", "synthetic", hourly=h) for k in range(401, len(df) + 1)]


def entries(days: list[dict], key: str = "稳定上涨") -> list[dict]:
    return [a for a in days if status(a, "P14") == "满足" and a["play"]["key"] == key]


def test_bottom_construct_after_the_pullback_reached_the_60_group_is_an_entry():
    # V 形：急跌穿过 60 线组，底部构造完成那天收盘已经回到 60 线组上方。② 是这次回撤里发生过的事，不要求还在线下
    days = pullback_days(down=6, drop=0.02, up=8, rise=0.025)
    construct = next(a for a in days if status(a, "P12") == "满足")
    ma60 = next(x for x in construct["lines"] if x["period"] == 60)
    assert construct["close"] > max(ma60["ma"], ma60["ema"])
    assert status(construct, "P11") == "满足"
    assert construct in entries(days)
    assert "可以结构性加仓" in construct["play"]["text"]


def test_20_60_cross_inside_an_intact_60_120_uptrend_is_still_a_pullback():
    # 慢而深的回撤，20/60 已经交叉，60/120 还是稳定上涨（视频 A 谷歌：第一次结构性加仓跌破了所有均线）
    days = pullback_days(down=16, drop=0.008, up=14, rise=0.004)
    crossed = [a for a in entries(days)
               if any(s["step"] == "第一个交叉" and s["date"] for s in (a["steps"][0]["current"] or {}).get("steps", []))]
    assert crossed
    assert all((a["regime"]["type"], a["regime"]["stage"]) == ("稳定上涨", "回撤中") for a in crossed)


def test_mirror_bounce_through_the_60_group_then_top_construct_is_a_sell():
    days = pullback_days(down=16, drop=0.008, up=14, rise=0.004, mirror=True)
    sells = entries(days, "稳定下跌")
    assert sells
    assert all(a["regime"]["stage"] == "反弹中" for a in sells)
    assert "减仓或离场" in sells[0]["play"]["text"]


def test_no_pullback_entry_once_60_120_breaks():
    days = pullback_days(down=16, drop=0.008, up=14, rise=0.004)
    broken = [a for a in days if a["regime"]["type"] is None]
    assert broken
    assert all(status(a, "P14") == "不满足" and a["play"]["key"] == "过渡" for a in broken)


def test_a_new_high_ends_the_pullback():
    # 回撤到过 60 线组之后又创新高：这次回撤结束，② 从新高重新算
    days = pullback_days(down=6, drop=0.02, up=55, rise=0.0025)
    peak = days[0]["close"] / 0.98
    i = next(i for i, a in enumerate(days) if a["close"] > peak)
    before, high = days[i - 1], days[i]
    assert (before["regime"]["type"], high["regime"]["type"]) == ("稳定上涨", "稳定上涨")
    assert (status(before, "P11"), status(high, "P11")) == ("满足", "不满足")
