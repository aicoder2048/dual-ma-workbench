"""新验证集：名单按规则生成、可复现；碰一次记一次；三条判定照事先写的算。"""
from __future__ import annotations

import pandas as pd
import pytest

import conftest  # noqa: F401
import fullplan as fp
import holdout as ho
import planrun as pr

EXCHANGES = ["NYQ", "NMS"]
MIN_START = pd.Timestamp("2023-08-20")


def quote(sym: str, cap: float, name: str | None = None, exchange: str = "NYQ", dollar: float = 1e8, kind: str = "EQUITY") -> dict:
    return {"symbol": sym, "marketCap": cap, "shortName": name or f"{sym} Inc", "exchange": exchange, "quoteType": kind,
            "regularMarketPrice": 100.0, "averageDailyVolume3Month": dollar / 100.0}


POOL = [
    quote("BIG", 2.5e11),                         # 超过 2000 亿：不在这一档
    quote("OTC", 1.9e11, exchange="PNK"),         # 场外：不算美国上市
    quote("AAA", 1.8e11),
    quote("THIN", 1.7e11, dollar=3e7),            # 成交额太小
    quote("OLD", 1.6e11),                         # 之前用过
    quote("PBR", 1.5e11, name="Petro"),
    quote("PBR-A", 1.4e11, name="Petro"),         # 同一家公司的另一类股
    quote("NEW", 1.3e11),                         # 历史不足
    quote("BBB", 1.2e11),
    quote("CCC", 1.1e11),
    quote("SMALL", 7.0e10),                       # 不到 800 亿
    quote("PREF", 1.0e11, kind="ETF"),
]
STARTS = {"AAA": "2009-12-01", "PBR": "2009-12-01", "NEW": "2024-03-27", "BBB": "2015-05-20", "CCC": "2009-12-01"}


def history(t: str) -> pd.Timestamp | None:
    return pd.Timestamp(STARTS[t]) if t in STARTS else None


def run_pick(n: int = 3, pool: list[dict] = POOL):
    return ho.pick(pool, {"之前的评估": {"OLD"}}, history, MIN_START, EXCHANGES, 5e7, n)


def test_pick_follows_the_written_rule_and_fills_from_below():
    chosen, excluded = run_pick()
    assert [c["ticker"] for c in chosen] == ["AAA", "PBR", "BBB"]
    assert chosen[2]["first_bar"] == "2015-05-20"
    why = {e["ticker"]: e["reason"] for e in excluded}
    assert set(why) == {"THIN", "OLD", "PBR-A", "NEW"}
    assert "成交额" in why["THIN"] and "之前的评估" in why["OLD"] and "PBR" in why["PBR-A"] and "历史不足" in why["NEW"]


def test_pick_is_deterministic_whatever_order_the_screener_returns():
    assert run_pick() == run_pick(pool=list(reversed(POOL)))


def test_pick_only_fetches_history_for_candidates_it_needs():
    asked = []
    ho.pick(POOL, {}, lambda t: asked.append(t) or history(t), MIN_START, EXCHANGES, 5e7, 1)
    assert asked == ["AAA"]


def test_committed_list_is_new_and_has_the_planned_size():
    doc = ho.load_list()
    tickers = ho.tickers_of(doc)
    assert len(doc["etfs"]) == 20 and len(doc["stocks"]) == 30 and len(set(tickers)) == 50
    assert not set(tickers) & (set(fp.CORE) | set(ho.PR20))
    assert all(ho.CAP_LO <= s["cap"] <= ho.CAP_HI for s in doc["stocks"])
    assert [s["cap"] for s in doc["stocks"]] == sorted((s["cap"] for s in doc["stocks"]), reverse=True)


# ---------- 计数和锁 ----------

def test_every_touch_is_counted(tmp_path):
    runs = tmp_path / "runs.json"
    assert ho.runs(runs) == []
    assert ho.record_run("holdout.py", ["VTI", "MCD"], "abc", runs) == 1
    assert ho.record_run("planrun.py", ["VTI"], "abc", runs) == 2
    assert [(r["n"], r["source"], r["tickers"]) for r in ho.runs(runs)] == [(1, "holdout.py", ["MCD", "VTI"]), (2, "planrun.py", ["VTI"])]


@pytest.fixture
def lock(tmp_path, monkeypatch):
    runs = tmp_path / "runs.json"
    monkeypatch.setattr(ho, "RUNS_FILE", runs)
    monkeypatch.setattr(pr.ev, "git", lambda *a: "abc")
    ho.record_run("holdout.py", ["VTI"], "abc", runs)
    return runs


def test_backtest_marks_holdout_tickers_and_counts_a_real_run(lock):
    est = pr.holdout(["NVDA", "VTI", "MCD"])
    assert est == {"locked": True, "overlap": ["MCD", "VTI"], "runs": 1}
    assert pr.touch_holdout(est)["runs"] == 2
    assert pr.holdout(["VTI"])["runs"] == 2


def test_backtest_off_the_holdout_is_not_counted(lock):
    est = pr.holdout(["NVDA"])
    assert est["overlap"] == [] and pr.touch_holdout(est) == est
    assert len(ho.runs(lock)) == 1


def test_without_a_list_nothing_is_locked(tmp_path, monkeypatch):
    monkeypatch.setattr(ho, "LIST_FILE", tmp_path / "none.json")
    monkeypatch.setattr(ho, "RUNS_FILE", tmp_path / "runs.json")
    assert pr.holdout(["VTI"]) == {"locked": False, "overlap": [], "runs": 0}


# ---------- 判定 ----------

def group(mean_r: float | None, ci: list[float] | None = None, mar: float | None = 0.5, ma200: float | None = 0.4) -> dict:
    return {"runs": {fp.FULL.name: {"mean_r": mean_r, "ci": ci, "mar": mar}}, "baselines": {"MA200 朴素规则": {"mar": ma200}}}


def test_all_three_pass():
    crit = ho.criteria(group(0.8, [0.2, 1.4]), group(0.5), group(1.0))
    assert [c["ok"] for c in crit] == [True, True, True]
    assert ho.verdict(crit) == "新验证集支持"


@pytest.mark.parametrize("pooled,etf,stock,failed", [
    (group(0.8, [-0.1, 1.4]), group(0.5), group(1.0), ["a"]),          # 区间跨 0
    (group(0.8, None), group(0.5), group(1.0), ["a"]),                 # 区间算不出
    (group(-0.8, [-1.5, -0.2]), group(-0.5), group(-1.0), ["a"]),      # 整个在 0 以下：方向一致也不算支持
    (group(0.8, [0.2, 1.4], mar=0.3), group(0.5), group(1.0), ["b"]),  # MAR 低于 MA200
    (group(0.8, [0.2, 1.4], mar=None), group(0.5), group(1.0), ["b"]),
    (group(0.8, [0.2, 1.4]), group(-0.1), group(1.0), ["c"]),          # 两组反向
    (group(0.8, [0.2, 1.4]), group(None), group(1.0), ["c"]),          # 一组没有交易
])
def test_each_failure_is_named(pooled, etf, stock, failed):
    crit = ho.criteria(pooled, etf, stock)
    assert [c["id"] for c in crit if not c["ok"]] == failed
    assert ho.verdict(crit) == f"新验证集不支持：第 {'、'.join(failed)} 条没过"


def test_random_percentile_counts_ties_as_half():
    assert ho.percentile(1.0, [0.0, 0.5, 1.0, 2.0]) == pytest.approx(0.625)
    assert ho.percentile(3.0, [0.0, None, 1.0]) == 1.0
    assert ho.percentile(None, [1.0]) is None
