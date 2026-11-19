#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Return the IV-vs-delta skew curve for a ticker's expiration.

Usage:
    get_skew_curve.py SYMBOL YYYY-MM-DD
    get_skew_curve.py SYMBOL YYYY-MM-DD 5,10,15,20,25,30   # custom delta bins (abs)

For each absolute-delta bin in DELTAS (default 5,10,15,20,25,30):
  - put_side:  find the put with |delta| closest to bin/100, report IV
  - call_side: find the call with delta closest to bin/100, report IV

Also reports the ATM IV (strike nearest spot) as the anchor — lets the caller
compute skew as (wing_iv − atm_iv).

Output JSON shape:
  {
    "symbol": "NVDA",
    "expiration": "2026-06-18",
    "spot": 215.33,
    "market_status": "open",
    "quote_freshness": "live",
    "atm_strike": 215.0,
    "atm_iv": 0.3245,
    "deltas": [5, 10, 15, 20, 25, 30],
    "put_side":  [{"delta_target": 5,  "strike": 195, "delta": -0.052, "iv": 0.412}, ...],
    "call_side": [{"delta_target": 5,  "strike": 240, "delta": +0.048, "iv": 0.305}, ...]
  }
"""

import json
import sys

from _http_helper import polygon_get

DEFAULT_DELTAS = [5, 10, 15, 20, 25, 30]


def fetch_spot_info(symbol: str) -> tuple[float | None, str | None]:
    v3 = polygon_get("/v3/snapshot", {"ticker.any_of": symbol})
    if v3 and v3.get("status") == "OK" and v3.get("results"):
        r = v3["results"][0]
        price = (r.get("session") or {}).get("price")
        return (float(price) if price is not None else None, r.get("market_status"))
    fallback = polygon_get(f"/v2/aggs/ticker/{symbol}/prev")
    if fallback and fallback.get("resultsCount", 0):
        return (float(fallback["results"][0]["c"]), None)
    return (None, None)


def freshness_from_status(market_status: str | None) -> str:
    return "live" if market_status in {"open", "regular"} else "stale_eod"


def fetch_side(symbol: str, expiration: str, side: str) -> list[dict]:
    data = polygon_get(
        f"/v3/snapshot/options/{symbol}",
        params={
            "expiration_date": expiration,
            "contract_type": side,
            "limit": 250,
            "order": "asc",
            "sort": "strike_price",
        },
    )
    if not data or not data.get("results"):
        return []
    rows = []
    for snap in data["results"]:
        details = snap.get("details", {})
        greeks = snap.get("greeks", {})
        rows.append(
            {
                "strike": float(details.get("strike_price") or 0),
                "delta": greeks.get("delta"),
                "iv": snap.get("implied_volatility"),
            }
        )
    # Drop rows missing delta or iv — they're not useful for the curve.
    return [r for r in rows if r["delta"] is not None and r["iv"] is not None]


def closest_by_delta(rows: list[dict], target_abs_delta: float) -> dict | None:
    """Find the row whose |delta| is closest to target_abs_delta. Returns None if no rows."""
    if not rows:
        return None
    return min(rows, key=lambda r: abs(abs(r["delta"]) - target_abs_delta))


def closest_strike_to(rows: list[dict], target_strike: float) -> dict | None:
    if not rows:
        return None
    return min(rows, key=lambda r: abs(r["strike"] - target_strike))


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: get_skew_curve.py SYMBOL YYYY-MM-DD [DELTA_BINS]", file=sys.stderr)
        sys.exit(2)
    symbol = sys.argv[1].upper()
    expiration = sys.argv[2]
    deltas = (
        [int(x) for x in sys.argv[3].split(",") if x.strip()]
        if len(sys.argv) > 3 and sys.argv[3].strip()
        else DEFAULT_DELTAS
    )

    spot, market_status = fetch_spot_info(symbol)
    puts = fetch_side(symbol, expiration, "put")
    calls = fetch_side(symbol, expiration, "call")

    # ATM anchor — use the side with non-empty rows; prefer calls then puts.
    atm_row = None
    if spot is not None:
        atm_call = closest_strike_to(calls, spot)
        atm_put = closest_strike_to(puts, spot)
        # Pick whichever is closer to spot; if both equally close, prefer call.
        if atm_call and atm_put:
            atm_row = atm_call if abs(atm_call["strike"] - spot) <= abs(atm_put["strike"] - spot) else atm_put
        else:
            atm_row = atm_call or atm_put

    put_side = []
    for d in deltas:
        target = d / 100.0
        row = closest_by_delta(puts, target)
        if row:
            put_side.append(
                {
                    "delta_target": d,
                    "strike": row["strike"],
                    "delta": row["delta"],
                    "iv": row["iv"],
                }
            )

    call_side = []
    for d in deltas:
        target = d / 100.0
        row = closest_by_delta(calls, target)
        if row:
            call_side.append(
                {
                    "delta_target": d,
                    "strike": row["strike"],
                    "delta": row["delta"],
                    "iv": row["iv"],
                }
            )

    out = {
        "symbol": symbol,
        "expiration": expiration,
        "spot": spot,
        "market_status": market_status,
        "quote_freshness": freshness_from_status(market_status),
        "atm_strike": atm_row["strike"] if atm_row else None,
        "atm_iv": atm_row["iv"] if atm_row else None,
        "atm_delta": atm_row["delta"] if atm_row else None,
        "deltas": deltas,
        "put_side": put_side,
        "call_side": call_side,
        "rows_counted": {"puts": len(puts), "calls": len(calls)},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
