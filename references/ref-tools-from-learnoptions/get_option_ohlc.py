#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Fetch OHLC bars for one or more option contracts via Polygon.io.

Usage:
    get_option_ohlc.py TICKER [TICKER ...]              # today's OHLC
    get_option_ohlc.py --days N TICKER [TICKER ...]     # last N days

Each TICKER is an OCC-format option symbol like NVDA260612C00250000.
Uses Polygon /v2/aggs (Stocks Starter + Options Starter tiers).
Returns O/H/L/C/VWAP + volume per contract.
"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

ENV_FILE = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=ENV_FILE)

API_KEY = os.getenv("POLYGON_API_KEY")
if not API_KEY:
    print(json.dumps({"error": "POLYGON_API_KEY not set in .env"}))
    sys.exit(1)

BASE = "https://api.polygon.io/v2/aggs/ticker"


def _parse_args():
    # Lightweight arg parsing — no click needed
    args = sys.argv[1:]
    days = 1
    tickers = []
    i = 0
    while i < len(args):
        if args[i] == "--days" and i + 1 < len(args):
            days = int(args[i + 1])
            i += 2
        else:
            tickers.append(args[i])
            i += 1
    if not tickers:
        print(json.dumps({"error": "at least one TICKER required"}))
        sys.exit(1)
    return days, tickers


def fetch(ticker: str, days: int):
    today = date.today()
    start = today - timedelta(days=days)
    url = (
        f"{BASE}/O:{ticker}/range/1/day"
        f"/{start.isoformat()}/{today.isoformat()}"
        f"?adjusted=true&sort=desc&limit={days}&apiKey={API_KEY}"
    )
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        return {"error": str(exc), "ticker": ticker}


def format_result(ticker: str, data: dict):
    out = {"ticker": ticker}
    results = data.get("results")
    if not results:
        out["status"] = data.get("status", "no_data")
        out["bars"] = []
        return out

    out["status"] = data.get("status", "ok")
    bars = []
    for row in results:
        bars.append(
            {
                "date": date.fromtimestamp(row["t"] / 1000).isoformat(),
                "o": row["o"],
                "h": row["h"],
                "l": row["l"],
                "c": row["c"],
                "vwap": round(row.get("vw", 0), 4),
                "vol": row["v"],
            }
        )
    out["bars"] = bars
    return out


def main():
    days, tickers = _parse_args()
    results = []
    for t in tickers:
        data = fetch(t, days)
        results.append(format_result(t, data))
    print(json.dumps({"results": results}, indent=2))


if __name__ == "__main__":
    main()
