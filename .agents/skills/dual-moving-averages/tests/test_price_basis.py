"""价格口径：yfinance 取到的开高低收只按拆股复权（和 Polygon adjusted=true、回测一样），不按分红复权。

假的 yf.download 照真 yfinance 的样子返回：auto_adjust=True 时开高低收按分红往下调、没有 Adj Close；
auto_adjust=False 时开高低收是拆股复权价，另给 Adj Close。列是 (字段, 代码) 两层。
最后一条联网比对 QQQ 2014-03-28 的收盘（87.05），没装 yfinance 或没网时跳过。
"""
from __future__ import annotations

import sys
import types

import numpy as np
import pandas as pd
import pytest

import backtest as bt
import dma_analyze as dma
import hourly as hr

DIVIDEND_FACTOR = 0.9   # 含分红复权价 = 拆股复权价 × 0.9
SPLIT_ONLY_CLOSE = 100.0


def fake_download(index: pd.DatetimeIndex):
    def download(ticker, start=None, end=None, interval="1d", auto_adjust=True, progress=True, **_):
        close = np.full(len(index), SPLIT_ONLY_CLOSE)
        k = DIVIDEND_FACTOR if auto_adjust else 1.0
        cols = {"Open": close * k, "High": close * k + 1, "Low": close * k - 1, "Close": close * k,
                "Volume": np.full(len(index), 1_000_000)}
        if not auto_adjust:
            cols["Adj Close"] = close * DIVIDEND_FACTOR
        df = pd.DataFrame(cols, index=index)
        df.columns = pd.MultiIndex.from_product([df.columns, [ticker]])
        return df
    return download


@pytest.fixture
def yf_stub(monkeypatch):
    def install(index: pd.DatetimeIndex) -> None:
        monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(download=fake_download(index)))
    return install


def test_workbench_yfinance_fallback_uses_split_only_prices(yf_stub):
    yf_stub(pd.bdate_range("2019-01-02", "2024-03-28"))
    daily, history, src = dma.load_prices("QQQ", None, "2024-03-28", None, "yfinance")
    assert daily["Close"].iloc[-1] == pytest.approx(SPLIT_ONLY_CLOSE)
    assert daily["Open"].iloc[-1] == pytest.approx(SPLIT_ONLY_CLOSE)
    assert "Adj Close" not in history.columns
    assert "只按拆股复权" in src


def test_hourly_yfinance_fallback_uses_split_only_prices(yf_stub):
    yf_stub(pd.date_range("2024-03-01 09:30", periods=40 * 7, freq="h", tz="America/New_York"))
    got = hr.fetch_yfinance_1h("QQQ", "2024-03-01", "2024-04-30")
    assert list(got.columns) == ["Close"]
    assert got["Close"].iloc[-1] == pytest.approx(SPLIT_ONLY_CLOSE)


def test_fetch_only_cache_uses_split_only_prices(yf_stub, tmp_path):
    yf_stub(pd.bdate_range("2017-12-01", pd.Timestamp.today().normalize() - pd.Timedelta(days=1)))
    px = bt.load(bt.ensure_data("QQQ", tmp_path, pd.Timestamp("2017-12-01")))
    assert px["Close"].iloc[-1] == pytest.approx(SPLIT_ONLY_CLOSE)
    assert list(px.columns) == bt.OHLCV


def test_fetch_only_refetches_an_old_dividend_adjusted_cache(yf_stub, tmp_path):
    """改口径之前的缓存只有开高低收量（含分红复权）：不认，重取。"""
    idx = pd.bdate_range("2017-12-01", pd.Timestamp.today().normalize() - pd.Timedelta(days=1))
    old = pd.DataFrame({c: SPLIT_ONLY_CLOSE * DIVIDEND_FACTOR for c in ("Open", "High", "Low", "Close")}, index=idx)
    old["Volume"] = 1_000_000
    old.index.name = "Date"
    old.to_csv(tmp_path / "QQQ.csv")
    yf_stub(idx)
    px = bt.load(bt.ensure_data("QQQ", tmp_path, pd.Timestamp("2017-12-01")))
    assert px["Close"].iloc[-1] == pytest.approx(SPLIT_ONLY_CLOSE)


def test_live_yfinance_qqq_2014_close_is_split_only():
    """联网：QQQ 2014-03-28 收盘 87.05（含分红复权是 79.18）。Polygon 套餐够不到这么早，工作台回放走的就是这条。"""
    pytest.importorskip("yfinance")
    try:
        daily, _, _ = dma.load_prices("QQQ", None, "2014-03-28", None, "yfinance")
    except (Exception, SystemExit) as exc:   # 没网、限流、yfinance 接口变了
        pytest.skip(f"yfinance 取不到：{exc}")
    assert daily.index[-1] == pd.Timestamp("2014-03-28")
    assert daily["Close"].iloc[-1] == pytest.approx(87.05, abs=0.01)
