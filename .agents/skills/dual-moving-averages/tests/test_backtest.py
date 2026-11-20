"""逐笔回测：每天的分析等于 dma_analyze.py --asof；不偷看未来；进出场日期和盈亏与手算一致。"""
from __future__ import annotations

import json
import subprocess
import sys
from urllib.parse import urlparse

import pandas as pd
import pytest

from conftest import FIXTURES, SCRIPTS
import backtest as bt
import hourly as hr
import trades as tr

C = tr.COST


def fixture(ticker: str) -> pd.DataFrame:
    return bt.load(FIXTURES / f"{ticker}.csv")


def plain(a: dict) -> dict:
    out = json.loads(json.dumps(a, ensure_ascii=False, allow_nan=False))
    return {k: v for k, v in out.items() if k not in ("label", "source")}


@pytest.mark.parametrize("ticker,date", [("SPY", "2022-06-15"), ("SPY", "2024-04-19"), ("TSLA", "2021-04-14")])
def test_in_process_analysis_equals_cli_asof(tmp_path, ticker, date):
    px = fixture(ticker)
    i = px.index.get_loc(pd.Timestamp(date))
    cut = tmp_path / f"{ticker}-{date}.csv"
    bt.cut_at(px, i).to_csv(cut)
    proc = subprocess.run([sys.executable, str(SCRIPTS / "dma_analyze.py"), "--csv", str(cut), "--asof", date, "--json"],
                          capture_output=True, text=True, check=True)
    assert plain(bt.analyze_on(px, i, ticker)) == plain(json.loads(proc.stdout)["analysis"])


def test_decision_ignores_everything_after_that_day():
    px = fixture("SPY")
    i = px.index.get_loc(pd.Timestamp("2024-04-19"))
    later = px.copy()
    later.iloc[i + 1:] = later.iloc[i + 1:] * 3       # 之后的行情全改掉
    assert bt.day_of(bt.analyze_on(later, i, "SPY")) == bt.day_of(bt.analyze_on(px, i, "SPY"))
    assert bt.cut_at(px, i).index[-1] == px.index[i]


def prices(opens: list[float], closes: list[float]) -> pd.DataFrame:
    idx = pd.bdate_range("2024-01-01", periods=len(opens))
    return pd.DataFrame({"Open": opens, "Close": closes}, index=idx, dtype=float)


PX = prices([10, 11, 12, 13, 14, 15, 16, 17], [10.5, 11.5, 12.5, 12.0, 13.0, 14.5, 16.5, 17.5])


def test_trade_enters_and_exits_next_open_with_hand_computed_pnl():
    ts = tr.simulate("X", PX, 0, lambda i: tr.Signal("s", "R", False) if i == 2 else None,
                     lambda i, _: "走" if i == 5 else None)
    assert len(ts) == 1
    t = ts[0]
    assert (t.signal, t.entry, t.exit) == ("2024-01-03", "2024-01-04", "2024-01-09")
    assert (t.entry_px, t.exit_px, t.bars, t.reason) == (13, 16, 3, "走")
    assert t.ret == pytest.approx(16 * (1 - C) / (13 * (1 + C)) - 1)
    assert t.mae == pytest.approx(12.0 / 13 - 1)      # 持有期收盘最低 12.0


def test_signal_on_last_bar_is_not_executed_and_open_trade_marks_to_last_close():
    ts = tr.simulate("X", PX, 0, lambda i: tr.Signal("s", "R", False) if i >= 5 else None, lambda i, _: None)
    t = ts[0]
    assert (t.entry, t.exit, t.reason) == ("2024-01-09", "2024-01-10", "未平仓")
    assert t.ret == pytest.approx(17.5 * (1 - C) / (16 * (1 + C)) - 1)


def test_future_prices_do_not_move_signal_or_entry():
    sig = lambda px: (lambda i: tr.Signal("s", "R", False) if px["Close"].iloc[i] > 12.2 else None)
    a = tr.simulate("X", PX, 0, sig(PX), lambda i, _: None)
    changed = PX.copy()
    changed.iloc[4:, :] = changed.iloc[4:, :] * 0.5
    b = tr.simulate("X", changed, 0, sig(changed), lambda i, _: None)
    assert (a[0].signal, a[0].entry, a[0].entry_px) == (b[0].signal, b[0].entry, b[0].entry_px)


def day(date: str, key: str = "横盘", **status: str) -> tr.Day:
    base = {r: "不满足" for r in ("P2", "P3", "P5", "P6", "P14", "P19", "P20")}
    yielded = frozenset(k for k, v in status.items() if v == "让位")
    base.update({k: ("满足" if v == "让位" else v) for k, v in status.items()})
    return tr.Day(date=date, key=key, type=None, stage=None, status=base, yielded=yielded, close=10, ema20=9,
                  dirs={"MA60": 1, "EMA60": 1, "EMA20": 1}, side20="多头")


def run(days: list[tr.Day], chart: tr.Chart = tr.Chart.MET) -> list[tr.Trade]:
    px = prices(list(range(10, 10 + len(days))), [x + 0.5 for x in range(10, 10 + len(days))])
    days = [tr.Day(**{**d.__dict__, "date": str(px.index[k].date())}) for k, d in enumerate(days)]
    return tr.rule_trades("X", px, days, chart)


def test_range_ambush_enters_on_p2_and_exits_on_p3():
    ts = run([day("", P2="满足"), day(""), day(""), day("", P3="满足"), day("")])
    assert [(t.rule, t.entry_i, t.exit_i, t.reason) for t in ts] == [("P2", 1, 4, "P3")]


def test_range_ambush_not_taken_when_its_stop_is_already_hit():
    assert run([day("", P2="满足", P3="满足"), day(""), day("")]) == []


def test_yielded_first_chance_is_not_an_entry():
    assert run([day("", key="多头结构回撤中", P19="让位"), day(""), day("")]) == []


def test_chart_status_runs_both_ways():
    days = [day("", key="稳定上涨", P14="需看图"), day(""), day("")]
    met = run(days, tr.Chart.MET)
    assert [(t.rule, t.chart, t.reason) for t in met] == [("P14", True, "未平仓")]
    assert run(days, tr.Chart.UNMET) == []


def test_curve_compounds_to_trade_return_and_counts_exposure():
    ts = tr.simulate("X", PX, 0, lambda i: tr.Signal("s", "R", False) if i == 2 else None,
                     lambda i, _: "走" if i == 5 else None)
    eq = tr.curve(PX, ts, 0)
    assert eq.iloc[-1] - 1 == pytest.approx(ts[0].ret)
    assert tr.exposure(PX, ts, 0) == pytest.approx(3 / 7)
    hold = tr.buy_hold("X", PX, 0)
    assert tr.curve(PX, [hold], 0).iloc[-1] - 1 == pytest.approx(17.5 * (1 - C) / (11 * (1 + C)) - 1)


def test_random_entry_averages_every_window_of_that_length():
    got = tr.random_entry(PX, 0, 2)
    windows = [(1, 3), (2, 4), (3, 5), (4, 6), (5, 7)]
    o = PX["Open"].tolist()
    assert got == pytest.approx(sum(o[b] * (1 - C) / (o[a] * (1 + C)) - 1 for a, b in windows) / len(windows))


def test_ignore_hourly_takes_p14_from_p10_to_p12():
    days = [day("", key="稳定上涨", P10="满足", P11="满足", P12="满足", P14="不满足"), day(""), day("")]
    assert [t.rule for t in run(days, tr.Chart.IGNORE_HOURLY)] == ["P14"]
    assert run(days, tr.Chart.MET) == []


def test_stable_uptrend_holds_through_20_60_double_cross_until_60_group_turns_down():
    def held(**kw) -> tr.Day:
        return tr.Day(**{**day("", key="稳定上涨").__dict__, **kw})
    cross = held(side20="空头")
    turn = held(side20="空头", dirs={"MA60": -1, "EMA60": -1, "EMA20": -1})
    ts = run([day("", key="稳定上涨", P14="满足"), cross, cross, turn, day("")])
    assert [(t.entry_i, t.exit_i, t.reason) for t in ts] == [(1, 4, "60 线组拐头向下")]


def _record_inputs(tmp_path):
    """两只票、开盘价已知的行情，加一份逐笔明细：保守口径两笔稳定上涨，另一口径一笔多头结构回撤中（记录不该读它）。"""
    idx = pd.bdate_range("2023-01-02", periods=10)
    opens = {"AAA": [10.0] * 10, "BBB": [20.0, 20, 22, 22, 22, 22, 22, 22, 22, 22]}
    for t, o in opens.items():
        pd.DataFrame({"Date": idx, "Open": o, "High": o, "Low": o, "Close": o, "Volume": 1}).to_csv(tmp_path / f"{t}.csv", index=False)

    def trade(ticker, setup, e, x, ret):
        return {"ticker": ticker, "setup": setup, "rule": "P14", "chart": False, "signal": str(idx[e - 1].date()),
                "entry": str(idx[e].date()), "entry_px": 1.0, "exit": str(idx[x].date()), "exit_px": 1.0, "reason": "60 线组拐头向下",
                "ret": ret, "bars": x - e, "mae": -0.01, "entry_i": e, "exit_i": x}
    js = {tr.Chart.UNMET.value: [trade("AAA", "稳定上涨", 2, 4, 0.10), trade("BBB", "稳定上涨", 2, 4, -0.02)],
          tr.Chart.MET.value: [trade("AAA", "多头结构回撤中", 2, 3, 0.5)]}
    path = tmp_path / "2023-01-13-trades.json"
    path.write_text(json.dumps(js, ensure_ascii=False))
    return path


def test_record_reads_the_conservative_variant_and_compares_with_random_entry(tmp_path):
    rec = bt.record_from(_record_inputs(tmp_path), tmp_path, "2023-01-03", ["AAA", "BBB"], "x.md", "2023-01-14")
    assert (rec["variant"], rec["from"], rec["to"]) == ("需看图当不满足", "2023-01-03", "2023-01-13")
    # 每种能买的打法都在；这段时间没进场的笔数是 0。空仓不买的打法（例如加速上涨）不在里面
    assert set(rec["setups"]) == {s.key for s in tr.SETUPS} and "加速上涨" not in rec["setups"]
    assert rec["setups"]["多头结构回撤中"] == {"entries": ["P19", "P20"], "trades": 0}
    s = rec["setups"]["稳定上涨"]
    assert (s["trades"], s["dates"], s["win_rate"], s["entries"]) == (2, 1, 0.5, ["P14"])
    assert s["median"] == pytest.approx(0.04) and s["few_dates"]
    # 随机进场拿 2 根：AAA 价格不动只扣成本；BBB 从第 1 根起只有第 1 根买会赚 10%（之后都平）
    rand = {t: tr.random_entry(bt.load(tmp_path / f"{t}.csv"), 1, 2) for t in ("AAA", "BBB")}
    assert s["excess"] == pytest.approx(((0.10 - rand["AAA"]) + (-0.02 - rand["BBB"])) / 2)


def test_record_cli_writes_next_to_the_report(tmp_path):
    trades = _record_inputs(tmp_path)
    subprocess.run([sys.executable, str(SCRIPTS / "backtest.py"), "AAA", "BBB", "--from", "2023-01-03", "--data", str(tmp_path),
                    "--out", str(tmp_path / "out"), "--record-from", str(trades), "--report", "2023-01-13-x.md"],
                   check=True, capture_output=True)
    rec = json.loads((tmp_path / "out" / "2023-01-13-x-record.json").read_text())
    assert rec["source_report"] == "2023-01-13-x.md" and rec["setups"]["稳定上涨"]["trades"] == 2


def test_hourly_slice_equals_load_hourly_on_the_same_feed():
    """hourly_at 切出的那段，等于 load_hourly(asof=那天) 向 Polygon 请求 [那天 − 60 天, 那天] 得到的结果。"""
    utc = pd.date_range("2024-01-02 09:00", "2024-05-01 00:00", freq="30min", tz="UTC")
    closes = [100 + (k % 37) * 0.3 + k * 0.01 for k in range(len(utc))]
    feed = pd.DataFrame({"Close": closes}, index=utc.tz_convert("America/New_York").tz_localize(None))

    def get_json(url: str) -> dict:
        start, end = urlparse(url).path.split("/")[-2:]
        keep = (feed.index >= start) & (feed.index < pd.Timestamp(end) + pd.Timedelta(days=1))
        ms = utc[keep].as_unit("ms").asi8.tolist()
        return {"results": [{"t": t, "c": c} for t, c in zip(ms, feed["Close"][keep])]}

    for d in ("2024-03-15", "2024-04-30"):
        live = hr.load_hourly("X", d, "key", "polygon", get_json, today=pd.Timestamp("2024-05-01"))
        assert live["available"], live
        assert bt.hourly_at(feed, pd.Timestamp(d)) == live
