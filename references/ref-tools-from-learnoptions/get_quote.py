#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Print a JSON quote for a ticker via Polygon.io.

Primary: /v3/snapshot Universal Snapshot — includes pre-market (early_trading)
and after-hours (late_trading) breakdown and a `market_status` field. Available
on Stocks Starter tier.

Fallback: /v2/snapshot single-ticker snapshot (regular-session only).
"""

import json
import sys
from functools import partial

import _http_helper

polygon_get = partial(_http_helper.polygon_get, missing_key_msg=_http_helper.POLYGON_KEY_MISSING_LONG)


def _round(v, n=4):
    return round(v, n) if isinstance(v, (int, float)) else v


def build_payload_from_v3(symbol: str, result: dict) -> dict:
    s = result.get("session", {}) or {}
    lm = result.get("last_minute", {}) or {}
    last_updated_ns = s.get("last_updated")
    as_of_ms = int(last_updated_ns / 1_000_000) if last_updated_ns else None

    payload = {
        "symbol": symbol,
        "name": result.get("name"),
        "market_status": result.get("market_status"),  # open | closed | early_hours | late_hours
        "price": _round(s.get("price"), 4),
        "previous_close": _round(s.get("previous_close"), 4),
        "open": _round(s.get("open"), 4),
        "high": _round(s.get("high"), 4),
        "low": _round(s.get("low"), 4),
        "close": _round(s.get("close"), 4),
        "volume": int(s["volume"]) if s.get("volume") is not None else None,
        "vwap": _round(s.get("vwap"), 4),
        "change": _round(s.get("change"), 4),
        "change_pct": _round(s.get("change_percent"), 2),
        "last_minute_close": _round(lm.get("close"), 4),
        "as_of_ms": as_of_ms,
        "source": "polygon-v3-snapshot",
    }

    # Optional extended-hours fields (only present when relevant)
    pre_chg = s.get("early_trading_change")
    pre_pct = s.get("early_trading_change_percent")
    if pre_chg is not None or pre_pct is not None:
        payload["premarket_change"] = _round(pre_chg, 4)
        payload["premarket_change_pct"] = _round(pre_pct, 2)

    post_chg = s.get("late_trading_change")
    post_pct = s.get("late_trading_change_percent")
    if post_chg is not None or post_pct is not None:
        payload["afterhours_change"] = _round(post_chg, 4)
        payload["afterhours_change_pct"] = _round(post_pct, 2)

    return payload


def build_payload_from_v2(symbol: str, ticker: dict) -> dict:
    day = ticker.get("day", {}) or {}
    prev = ticker.get("prevDay", {}) or {}
    last_trade = ticker.get("lastTrade", {}) or {}
    price = last_trade.get("p") or day.get("c")
    prev_c = prev.get("c", price)
    chg = (
        round((price - prev_c) / prev_c * 100, 2) if prev_c and price else 0.0
    )
    return {
        "symbol": symbol,
        "market_status": None,  # v2 doesn't expose this cleanly
        "price": price,
        "previous_close": prev_c,
        "open": day.get("o"),
        "high": day.get("h"),
        "low": day.get("l"),
        "volume": int(day["v"]) if day.get("v") is not None else None,
        "change_pct": chg,
        "source": "polygon-v2-snapshot-fallback",
        "as_of_ms": day.get("t"),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing symbol arg"}), file=sys.stderr)
        return 2

    symbol = sys.argv[1].upper()
    try:
        # Primary: v3 universal snapshot — includes pre/post-market
        v3 = polygon_get("/v3/snapshot", {"ticker.any_of": symbol})
        if v3 and v3.get("status") == "OK" and v3.get("results"):
            print(json.dumps(build_payload_from_v3(symbol, v3["results"][0])))
            return 0

        # Fallback: v2 single-ticker snapshot
        v2 = polygon_get(f"/v2/snapshot/locale/us/markets/stocks/tickers/{symbol}")
        if v2 and v2.get("ticker"):
            print(json.dumps(build_payload_from_v2(symbol, v2["ticker"])))
            return 0

        print(
            json.dumps({"error": f"no Polygon data for {symbol}"}), file=sys.stderr
        )
        return 3
    except Exception as exc:
        print(json.dumps({"error": str(exc), "symbol": symbol}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
