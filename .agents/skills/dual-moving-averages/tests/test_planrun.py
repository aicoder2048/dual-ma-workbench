"""回测方案：文件格式错了直接报错；方案变成 plansim 的参数；命令行跑出来的结果和完整计划报告逐笔一样。"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

from conftest import FIXTURES, SCRIPTS
import evalstats as es
import evaluate as ev
import fullplan as fp
import planrun as pr

CFG = es.load_config(ev.CONFIG)
TEMPLATE = pr.template(CFG)


def edit(pattern: str, repl: str, text: str = TEMPLATE) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    assert n == 1, pattern
    return out


# ---------- 方案文件 ----------

def test_template_is_the_full_plan_report_setting():
    p = pr.parse_plan(TEMPLATE)
    assert (p.universe, p.tickers, p.start, p.end) == ("tickers", ("NVDA",), "2013-01-02", "2026-11-19")
    assert pr.nondefault(p, CFG) == []
    c = p.sim_config()
    assert (c.risk_pct, c.risk_amount, c.stop_on_close, c.max_position, c.cost, c.equity0, c.stop_floor_atr) == \
        (1.0, None, True, 0.25, 0.0005, 1_000_000.0, None)
    v = p.variant()
    assert (v.rr_filter, v.targets, v.intraday_stop, v.equal_notional) == (True, True, False, False)


@pytest.mark.parametrize("pattern,repl,msg", [
    (r"^version = 1", "version = 2", "version 应为 1"),
    (r'^mode = "fullplan"', 'mode = "grid"', "第二期"),
    (r'^kind = "tickers"', 'kind = "all"', "kind 只能是"),
    (r'^tickers = \["NVDA"\]', "tickers = []", "至少列一只票"),
    (r'^tickers = \["NVDA"\]', 'tickers = ["NV DA"]', "代码不合法"),
    (r'^tickers = .*\n', "", "[universe] 缺 tickers"),
    (r'^start = "2013-01-02"', 'start = "2013-13-02"', "start 应为 YYYY-MM-DD"),
    (r'^start = "2013-01-02"', "start = 2013-01-02", "日期要加引号"),
    (r'^start = "2013-01-02"', 'start = "2027-01-01"', "要早于 end"),
    (r'^stop = "close"', 'stop = "low"', "stop 只能是"),
    (r"^risk_pct = 1.0", "risk_pct = 0", "risk_pct = 0 不在"),
    (r"^risk_pct = 1.0", "risk_pct = 25", "risk_pct = 25 不在"),
    (r"^risk_pct = 1.0", 'risk_pct = "1%"', "risk_pct 的类型不对"),
    (r"^max_position = 0.25", "max_position = 1.5", "max_position = 1.5 不在"),
    (r"^rr_filter = true", "rr_filter = 1", "rr_filter 的类型不对"),
    (r"^account = 1000000.0", "account = true", "account 的类型不对"),
    (r"^stop_floor_atr = 0.0", "stop_floor_atr = 0.75", "只能是 0 / 0.5 / 1"),
    (r"^cost = 0.0005", "cost = 0.05", "cost = 0.05 不在"),
    (r"^cost = 0.0005", "cost = 0.0005\nslippage = 0.001", "不认识的键 ['slippage']"),
    (r"^cost = .*\n", "", "缺 cost"),
    (r"^\[period\]", "[period\n", "TOML 语法错误"),
])
def test_bad_values_fail_loudly(pattern, repl, msg):
    with pytest.raises(pr.PlanError, match=re.escape(msg)):
        pr.parse_plan(edit(pattern, repl))


def test_risk_amount_bigger_than_the_account_is_rejected():
    text = edit(r'^risk = "pct"', 'risk = "amount"', edit(r"^risk_amount = 10000.0", "risk_amount = 2000000.0"))
    with pytest.raises(pr.PlanError, match="比起始资金"):
        pr.parse_plan(text)


def test_execution_switches_become_one_engine_config():
    text = TEMPLATE
    for pattern, repl in ((r'^stop = "close"', 'stop = "intraday"'), (r'^risk = "pct"', 'risk = "amount"'),
                          (r"^max_position = 0.25", "max_position = 0"), (r"^stop_floor_atr = 0.0", "stop_floor_atr = 0.5"),
                          (r"^targets = true", "targets = false")):
        text = edit(pattern, repl, text)
    p = pr.parse_plan(text)
    c = p.sim_config()
    assert (c.stop_on_close, c.risk_amount, c.max_position, c.stop_floor_atr) == (False, 10_000.0, None, 0.5)
    assert p.variant().targets is False
    assert [x["key"] for x in pr.nondefault(p, CFG)] == ["stop", "max_position", "stop_floor_atr", "targets"]
    assert pr.parse_plan(text) == p                                     # 同一份文件读两次一样


def test_plan_doc_round_trips_through_toml_shape():
    p = pr.parse_plan(edit(r"^max_position = 0.25", "max_position = 0"))
    doc = pr.plan_doc(p)
    assert doc["execution"]["max_position"] == 0.0 and doc["universe"] == {"kind": "tickers", "tickers": ["NVDA"]}


def test_core_resolves_to_the_users_core_list_and_watchlist_needs_a_snapshot():
    core = pr.parse_plan(edit(r'^kind = "tickers"', 'kind = "core"', edit(r'^tickers = \["NVDA"\]', "tickers = []")))
    assert pr.resolve(core) == list(fp.CORE) and len(fp.CORE) == 38
    wl = pr.parse_plan(edit(r'^kind = "tickers"', 'kind = "watchlist"', edit(r'^tickers = \["NVDA"\]', "tickers = []")))
    with pytest.raises(pr.PlanError, match="自选股是空的"):
        pr.resolve(wl)


# ---------- 命令行：真的跑一遍（测试行情，从头算每天的计划） ----------

@pytest.fixture(scope="module")
def market(tmp_path_factory) -> Path:
    """测试行情没有 Adj Close：当作没有分红（复权因子 1）。"""
    data = tmp_path_factory.mktemp("data")
    for t in ("SPY", "GOOGL", "AAPL"):
        df = pd.read_csv(FIXTURES / f"{t}.csv")
        df["Adj Close"] = df["Close"]
        df.to_csv(data / f"{t}.csv", index=False)
    return data


def cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPTS / "planrun.py"), *args], capture_output=True, text=True)


def test_cli_estimates_runs_streams_progress_and_reuses_the_cache(tmp_path, market):
    plan = tmp_path / "p.toml"
    plan.write_text(edit(r'^tickers = \["NVDA"\]', 'tickers = ["SPY", "GOOGL", "ZZZZ"]', edit(r'^start = "2013-01-02"', 'start = "2024-01-02"')))
    cache = tmp_path / "cache"
    est = json.loads(cli(str(plan), "--estimate", "--data", str(market), "--cache", str(cache), "--jobs", "4").stdout)
    assert [r["status"] for r in est["rows"]] == ["compute", "compute", "download"]   # ZZZZ 没有行情：要下载
    assert est["rows"][0]["days"] == len(pd.read_csv(market / "SPY.csv").query("Date >= '2024-01-02'"))
    assert (est["holdout"]["locked"], est["holdout"]["overlap"]) == (True, [])

    text = edit(r'^tickers = \["NVDA"\]', 'tickers = ["SPY", "GOOGL", "AAPL"]', edit(r'^start = "2013-01-02"', 'start = "2024-01-02"'))
    plan.write_text(text)
    out = tmp_path / "r.json"
    proc = cli(str(plan), "--out", str(out), "--data", str(market), "--cache", str(cache), "--jobs", "4")
    assert proc.returncode == 0, proc.stderr
    events = [json.loads(line) for line in proc.stdout.splitlines()]
    assert events[-1]["event"] == "done" and {e["stage"] for e in events[:-1]} == {"plans", "sim"}
    assert any(e["text"].startswith("SPY 完成") for e in events[:-1])
    r = json.loads(out.read_text())
    assert (r["kind"], r["meta"]["tickers"], r["meta"]["start"], r["meta"]["computed"]) == \
        (pr.RESULT_KIND, ["GOOGL", "SPY"], "2024-01-02", ["SPY", "GOOGL", "AAPL"])
    assert r["meta"]["skipped"] == {"AAPL": "这段时间没有计划"}            # 测试行情 2021 年就结束了
    assert set(r["summary"]["baselines"]) == {"买入持有", "MA200 朴素规则"}
    assert len(r["equity"]["dates"]) == len(r["equity"]["plan"]) == len(r["equity"]["买入持有"])
    assert all(r["meta"]["start"] <= t["signal_date"] <= r["plan"]["period"]["end"] for t in r["trades"])
    assert r["plan"] == pr.plan_doc(pr.parse_plan(text))

    again = cli(str(plan), "--estimate", "--data", str(market), "--cache", str(cache))
    assert [r["status"] for r in json.loads(again.stdout)["rows"]] == ["cached", "cached", "cached"]


def test_cli_rejects_a_bad_plan_with_the_reason(tmp_path):
    plan = tmp_path / "p.toml"
    plan.write_text(edit(r"^risk_pct = 1.0", "risk_pct = -1"))
    proc = cli(str(plan), "--estimate")
    assert proc.returncode != 0 and "risk_pct = -1 不在" in proc.stderr


# ---------- 和完整计划报告（2026-11-21 核心名单，筹码山改作参考之后）逐笔一样 ----------

# 网页的默认方案和这份报告逐笔一样。筹码山不排进第一目标（docs/adr/0018.md），这份和 main 的基线（-main.json）逐笔相同
REPORT = pr.OUT / "2026-11-21-fullplan-core-p38ref.json"


@pytest.mark.skipif(not REPORT.exists() or not (pr.OUT / "fullplan" / "daily" / "NVDA.jsonl").exists(),
                    reason="本机没有核心名单报告和每天计划的缓存（reports/ 不进仓库）")
def test_core_plan_reproduces_the_core_report_trade_by_trade(capsys):
    text = edit(r'^kind = "tickers"', 'kind = "core"', edit(r'^tickers = \["NVDA"\]', "tickers = []"))
    r = pr.run(pr.parse_plan(text), pr.OUT / "data" / "eval", pr.OUT, 4)
    old = json.loads(REPORT.read_text())["groups"]["合并（A+B+C）"]
    for k in ("trades", "mean_r", "ci", "win", "cagr", "mdd", "mar", "exposure", "streak"):
        assert r["summary"]["plan"][k] == old["runs"][fp.FULL.name][k], k
    assert r["summary"]["baselines"] == {k: old["baselines"][k] for k in ("买入持有", "MA200 朴素规则")}
    key = lambda t: (t["ticker"], t["entry_date"], t["exit_date"], t["fill"], t["exit_px"], t["shares"], t["r"], t["reason"])  # noqa: E731
    assert sorted(map(key, r["trades"])) == sorted(map(key, old["trades"]))
