"""财报日：过去几次和下一次，给图上的 E 标记和结论卡片的跳空提醒用。只是信息，不进任何规则。

数据源：yfinance 的 Ticker.get_earnings_dates（Polygon 的 Benzinga 财报接口不在我们的档位里，2026-11 查过）。
每只票缓存一天（$DMA_CACHE_DIR 或 ~/.cache/dual-moving-averages/earnings/<代码>.json）。取不到时返回
{"available": False, "reason": ...}，不抛错：财报日取不到不该让整份分析失败。
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

import pandas as pd

WARN_DAYS = 10              # 脚本自定：下次财报在 10 个交易日内，结论卡片提醒跳空可能越过止损
CACHE_SECONDS = 24 * 3600
FETCH_LIMIT = 60            # 季报一年 4 次，60 次约 15 年，回放老日子也找得到"下一次"
MAX_GAP_DAYS = 120          # 自然日：两次财报一般隔 3 个月；asof 之后 120 天还没有，说明数据没覆盖到，不猜

Fetch = Callable[[str], list[str]]


def fetch_yfinance(ticker: str) -> list[str]:
    """yfinance 给的全部财报日（美东日期，升序）。ETF、指数没有财报，返回空列表；网络错误照常抛出。"""
    import yfinance as yf

    with contextlib.redirect_stdout(sys.stderr):  # yfinance 偶尔往 stdout 打字，会弄坏 --json 的输出
        df = yf.Ticker(ticker).get_earnings_dates(limit=FETCH_LIMIT)
    if df is None or df.empty:
        return []
    return sorted({str(d.date()) for d in df.index})


def cache_file(ticker: str) -> Path:
    root = Path(os.environ.get("DMA_CACHE_DIR") or Path.home() / ".cache/dual-moving-averages")
    return root / "earnings" / f"{ticker.upper()}.json"


def cached_dates(ticker: str, fetch: Fetch = fetch_yfinance, now: Callable[[], float] = time.time) -> list[str]:
    """一天内用缓存，过期或没有就重新取。取数报错不写缓存，下次重试。"""
    path = cache_file(ticker)
    try:
        hit = json.loads(path.read_text())
        if now() - hit["at"] < CACHE_SECONDS:
            return hit["dates"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    dates = fetch(ticker)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"at": now(), "dates": dates}))
        tmp.replace(path)
    except OSError:
        pass  # 缓存写不了只是慢一点
    return dates


def earnings_json(dates: list[str], asof: str, since: str, ticker: str, source: str = "yfinance") -> dict:
    """asof 那天看到的财报日：since（日线窗口第一天）到 asof 之间的过去几次，asof 之后的第一次。

    days_to_next 是 asof 之后到那天的工作日数（和推演一样不扣节假日），明天就是 1。
    """
    if not dates:
        return {"available": False, "reason": f"{source} 没有 {ticker} 的财报日（ETF、指数没有财报）"}
    past = [d for d in dates if since <= d <= asof]
    later = [d for d in dates if d > asof]
    nxt = later[0] if later and (pd.Timestamp(later[0]) - pd.Timestamp(asof)).days <= MAX_GAP_DAYS else None
    days = len(pd.bdate_range(pd.Timestamp(asof) + pd.Timedelta(days=1), nxt)) if nxt else None
    return {"available": True, "past": past, "next": nxt, "days_to_next": days, "source": source}


def load_earnings(ticker: str, asof: str, since: str, fetch: Fetch = fetch_yfinance,
                  now: Callable[[], float] = time.time) -> dict:
    try:
        dates = cached_dates(ticker, fetch, now)
    except Exception as exc:  # 网络、限流、yfinance 改版：都只是没有财报日
        return {"available": False, "reason": f"财报日取不到：{type(exc).__name__} {str(exc)[:120]}"}
    return earnings_json(dates, asof, since, ticker)
