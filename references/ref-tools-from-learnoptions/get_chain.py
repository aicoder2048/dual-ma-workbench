#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Print a JSON option chain for a ticker via Polygon.io.

Usage:
    get_chain.py SYMBOL                       # list available expirations
    get_chain.py SYMBOL YYYY-MM-DD            # chain for that expiration (default 10 near-ATM each side)
    get_chain.py SYMBOL YYYY-MM-DD LIMIT      # chain with custom per-side row cap

The snapshot endpoint returns Greeks (delta, gamma, theta) and IV alongside
quotes — a strict upgrade over Yahoo Finance.
"""

import json
import sys
from functools import partial

import _http_helper
from _http_helper import list_option_expirations

polygon_get = partial(_http_helper.polygon_get, missing_key_msg=_http_helper.POLYGON_KEY_MISSING_LONG)


def fetch_spot_info(symbol: str) -> tuple[float | None, str | None]:
    """Fetch the latest cross-session spot price + market_status.

    Uses /v3/snapshot Universal Snapshot so the spot reflects pre-market
    (early_trading) and after-hours (late_trading) pricing, not yesterday's
    close. Falls back to /v2/aggs/.../prev when v3 is unavailable.
    """
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
    """Map Polygon market_status to a coarse quote-freshness label.

    US single-stock equity options only trade 9:30–16:00/16:15 ET. Outside
    that window the snapshot's day.* / greeks / IV are end-of-day values
    from the last regular session and last_quote is absent.
    """
    if market_status in {"open", "regular"}:
        return "live"
    return "stale_eod"


def is_standard_contract(details: dict, symbol: str) -> bool:
    """Keep only standard contracts: ticker root == symbol, 100 shares.

    Polygon also returns adjusted / non-standard series (e.g. O:B1SPY...,
    European-style, or post-corporate-action roots like SPY1) that share the
    same strike and would show up as duplicate rows.
    """
    ticker = details.get("ticker") or ""
    rest = ticker.removeprefix("O:")
    if not rest.startswith(symbol.upper()) or not rest[len(symbol):][:6].isdigit():
        return False
    return details.get("shares_per_contract", 100) == 100


def fetch_side(symbol: str, expiration: str, side: str) -> list[dict]:
    """One snapshot call for one side (calls or puts)."""
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

    rows: list[dict] = []
    for snap in data["results"]:
        details = snap.get("details", {})
        if not is_standard_contract(details, symbol):
            continue
        greeks = snap.get("greeks", {})
        day = snap.get("day", {})
        last_quote = snap.get("last_quote", {})

        bid = float(last_quote.get("bid") or 0)
        ask = float(last_quote.get("ask") or 0)
        if bid > 0 and ask > 0:
            mid = round((bid + ask) / 2, 4)
        else:
            mid = float(day.get("close") or 0) or None

        rows.append(
            {
                "strike": float(details.get("strike_price") or 0),
                "bid": bid or None,
                "ask": ask or None,
                "mid": mid,
                "iv": snap.get("implied_volatility"),
                "delta": greeks.get("delta"),
                "gamma": greeks.get("gamma"),
                "theta": greeks.get("theta"),
                "vega": greeks.get("vega"),
                "volume": int(day.get("volume") or 0) or None,
                "open_interest": int(snap.get("open_interest") or 0) or None,
            }
        )
    return rows


def pick_near_atm(rows: list[dict], spot: float | None, n: int) -> list[dict]:
    if not rows:
        return rows
    if spot is None:
        return rows[:n]
    sorted_by_distance = sorted(rows, key=lambda r: abs(r["strike"] - spot))
    return sorted(sorted_by_distance[:n], key=lambda r: r["strike"])


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing symbol"}), file=sys.stderr)
        return 2

    symbol = sys.argv[1].upper()
    expiration = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    try:
        limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 10
    except ValueError:
        print(json.dumps({"error": f"bad limit: {sys.argv[3]!r}"}), file=sys.stderr)
        return 2

    try:
        if not expiration:
            exps = list_option_expirations(symbol, "put")
            if not exps:
                print(
                    json.dumps({"error": f"no expirations for {symbol}", "symbol": symbol}),
                    file=sys.stderr,
                )
                return 3
            print(json.dumps({"symbol": symbol, "expirations": exps, "source": "polygon"}))
            return 0

        # Validate expiration is in the list before two snapshot calls
        exps = list_option_expirations(symbol, "put")
        if expiration not in exps:
            print(
                json.dumps(
                    {
                        "error": f"{expiration} not in available expirations",
                        "symbol": symbol,
                        "expirations": exps,
                    }
                ),
                file=sys.stderr,
            )
            return 3

        spot, market_status = fetch_spot_info(symbol)
        calls = fetch_side(symbol, expiration, "call")
        puts = fetch_side(symbol, expiration, "put")

        out = {
            "symbol": symbol,
            "expiration": expiration,
            "spot": spot,
            "market_status": market_status,
            "quote_freshness": freshness_from_status(market_status),
            "limit": limit,
            "calls": pick_near_atm(calls, spot, limit),
            "puts": pick_near_atm(puts, spot, limit),
            "source": "polygon",
        }
        print(json.dumps(out, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "symbol": symbol}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
