#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0"]
# ///
"""Print real CBOE VIX (and related vol indices) as JSON via Yahoo Finance.

Polygon's Indices tier is not subscribed, so I:VIX is unavailable there;
Yahoo's public chart endpoint serves ^VIX for free (no API key).

Usage:
    get_vix.py                 # ^VIX + term structure (^VIX9D, ^VIX3M, ^VIX6M)
    get_vix.py --days N        # also include last N daily closes of ^VIX

Regime thresholds (VIX level): <15 calm, 15-20 normal, 20-25 elevated,
25-30 high, >=30 extreme.
"""

import json
import sys
from datetime import datetime, timezone

import requests

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
HEADERS = {"User-Agent": "Mozilla/5.0"}  # Yahoo rejects requests without a UA
TERM_SYMBOLS = ["^VIX9D", "^VIX", "^VIX3M", "^VIX6M"]


def fetch_chart(symbol: str, range_: str = "5d") -> dict:
    """Return Yahoo chart result for one symbol; raises on HTTP/API error."""
    resp = requests.get(
        CHART_URL.format(symbol=symbol),
        params={"range": range_, "interval": "1d"},
        headers=HEADERS,
        timeout=15,
    )
    resp.raise_for_status()
    chart = resp.json().get("chart", {})
    if chart.get("error") or not chart.get("result"):
        raise RuntimeError(f"Yahoo error for {symbol}: {chart.get('error')}")
    return chart["result"][0]


def summarize(result: dict) -> dict:
    meta = result["meta"]
    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    closes = result.get("indicators", {}).get("quote", [{}])[0].get("close") or []
    # chartPreviousClose is the close before the range; prefer the prior bar
    valid = [c for c in closes if c is not None]
    if len(valid) >= 2:
        prev = valid[-2]
    change = round(price - prev, 2) if price is not None and prev else None
    ts = meta.get("regularMarketTime")
    return {
        "symbol": meta.get("symbol"),
        "price": price,
        "previous_close": round(prev, 2) if prev else None,
        "change": change,
        "change_pct": round(change / prev * 100, 2) if change is not None else None,
        "as_of": datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None,
    }


def regime(vix: float | None) -> str | None:
    if vix is None:
        return None
    for limit, label in [(15, "calm"), (20, "normal"), (25, "elevated"), (30, "high")]:
        if vix < limit:
            return label
    return "extreme"


def parse_days(argv: list[str]) -> int:
    if not argv:
        return 0
    if len(argv) == 2 and argv[0] == "--days" and argv[1].isdigit() and int(argv[1]) > 0:
        return int(argv[1])
    raise SystemExit("usage: get_vix.py [--days N]")


def main() -> int:
    days = parse_days(sys.argv[1:])
    out: dict = {"source": "yahoo-finance"}
    term: dict = {}
    for sym in TERM_SYMBOLS:
        try:
            range_ = "1y" if sym == "^VIX" and days > 5 else "5d"
            res = fetch_chart(sym, range_)
            term[sym] = summarize(res)
            if sym == "^VIX" and days:
                ts = res.get("timestamp") or []
                closes = res["indicators"]["quote"][0]["close"]
                hist = [
                    {"date": datetime.fromtimestamp(t, timezone.utc).date().isoformat(), "close": round(c, 2)}
                    for t, c in zip(ts, closes) if c is not None
                ]
                out["vix_history"] = hist[-days:]
        except Exception as e:  # report per-symbol failure, keep others
            term[sym] = {"error": str(e)}

    vix = term.get("^VIX", {}).get("price")
    if vix is None:
        print(json.dumps({"error": "failed to fetch ^VIX", "detail": term.get("^VIX")}))
        return 1
    out["vix"] = term["^VIX"]
    out["regime"] = regime(vix)
    out["term_structure"] = term
    v3m = term.get("^VIX3M", {}).get("price")
    if v3m:
        ratio = round(vix / v3m, 3)
        out["vix_vix3m_ratio"] = ratio
        out["curve"] = "backwardation" if ratio > 1 else "contango"
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
