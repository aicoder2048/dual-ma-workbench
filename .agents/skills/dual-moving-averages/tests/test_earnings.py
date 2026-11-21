"""财报日：过去几次和下一次、按天缓存、取不到时写明原因（不联网，取数函数是替身）。"""
from __future__ import annotations

import json

import pytest

from conftest import load_fixture
import dma_analyze as dma
import earnings as ea

DATES = ["2025-10-22", "2026-01-28", "2026-04-22", "2026-07-22", "2026-10-21", "2027-01-27"]


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DMA_CACHE_DIR", str(tmp_path))
    return tmp_path


def test_past_dates_inside_the_window_and_the_next_one_after_asof():
    e = ea.earnings_json(DATES, asof="2026-11-20", since="2026-01-01", ticker="TSLA")
    assert e == {"available": True, "past": ["2026-01-28", "2026-04-22", "2026-07-22", "2026-10-21"],
                 "next": "2027-01-27", "days_to_next": 48, "source": "yfinance"}


def test_days_to_next_counts_weekdays_after_asof():
    # 周五看下周二：周一、周二两个工作日
    e = ea.earnings_json(["2026-11-24"], asof="2026-11-20", since="2026-01-01", ticker="X")
    assert (e["next"], e["days_to_next"]) == ("2026-11-24", 2)


def test_replay_sees_the_earnings_day_itself_as_past():
    e = ea.earnings_json(DATES, asof="2026-07-22", since="2025-01-01", ticker="TSLA")
    assert e["past"][-1] == "2026-07-22" and e["next"] == "2026-10-21"


def test_next_too_far_after_asof_means_the_data_does_not_cover_it():
    e = ea.earnings_json(DATES, asof="2020-01-02", since="2017-01-01", ticker="TSLA")
    assert e["available"] and e["past"] == [] and e["next"] is None and e["days_to_next"] is None


def test_no_dates_is_unavailable_with_a_reason():
    e = ea.earnings_json([], asof="2026-11-20", since="2026-01-01", ticker="SPY")
    assert e == {"available": False, "reason": "yfinance 没有 SPY 的财报日（ETF、指数没有财报）"}


def test_cache_is_used_for_a_day_then_refetched():
    calls = []

    def fetch(t):
        calls.append(t)
        return DATES

    assert ea.cached_dates("tsla", fetch, now=lambda: 1000.0) == DATES
    assert ea.cached_dates("TSLA", fetch, now=lambda: 1000.0 + ea.CACHE_SECONDS - 1) == DATES
    assert calls == ["tsla"]
    ea.cached_dates("TSLA", fetch, now=lambda: 1000.0 + ea.CACHE_SECONDS)
    assert calls == ["tsla", "TSLA"]


def test_corrupt_cache_is_refetched():
    path = ea.cache_file("TSLA")
    path.parent.mkdir(parents=True)
    path.write_text("not json")
    assert ea.cached_dates("TSLA", lambda t: DATES) == DATES
    assert json.loads(path.read_text())["dates"] == DATES


def test_network_failure_is_unavailable_and_not_cached():
    def down(_t):
        raise ConnectionError("no route to host")

    e = ea.load_earnings("TSLA", "2026-11-20", "2026-01-01", fetch=down)
    assert e["available"] is False and "ConnectionError" in e["reason"]
    assert not ea.cache_file("TSLA").exists()
    assert ea.load_earnings("TSLA", "2026-11-20", "2026-01-01", fetch=lambda t: DATES)["next"] == "2027-01-27"


def test_analysis_json_carries_earnings_and_the_warning_window():
    df = load_fixture("TSLA", "2021-04-14")
    e = ea.load_earnings("TSLA", "2021-04-14", str(df.index[0].date()), fetch=lambda t: ["2021-01-27", "2021-04-26"])
    a = dma.analyze(df, "TSLA", "fixture", earnings=e)
    assert a["earnings"]["next"] == "2021-04-26" and a["earnings"]["days_to_next"] == 8
    assert a["thresholds"]["EARNINGS_WARN_DAYS"] == {"value": 10, "source": "脚本自定"}
    assert "下次财报：2021-04-26（8 个交易日后）" in dma.render_markdown(a)


def test_without_earnings_the_analysis_says_why():
    a = dma.analyze(load_fixture("TSLA", "2021-04-14"), "TSLA", "fixture")
    assert a["earnings"] == {"available": False, "reason": "CSV 模式不取财报日"}  # 和 --csv 一样：回测、扫描逐根对得上
