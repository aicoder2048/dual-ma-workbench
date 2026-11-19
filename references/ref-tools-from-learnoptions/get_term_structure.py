#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""IV term structure for a ticker: same |delta| across consecutive expirations.

Usage:
    get_term_structure.py SYMBOL                       # default: ATM (|Δ|≈50), next 5 expirations
    get_term_structure.py SYMBOL 25                    # |Δ|≈25, next 5 expirations
    get_term_structure.py SYMBOL 25 8                  # |Δ|≈25, next 8 expirations
    get_term_structure.py SYMBOL 25 8 put              # specify side (default: both → puts)

For each of the next N expirations (default 5), finds the put strike with
|delta| closest to the target and reports its IV. Returns the IV curve plus
a coarse shape classification:
  - contango       : back-dated IV > front-dated (normal regime)
  - backwardation  : front-dated IV > back-dated (event-driven, vol crush ahead)
  - flat           : difference <= 1vp across the curve

Output JSON:
  {
    "symbol": "NVDA",
    "target_abs_delta": 25,
    "side": "put",
    "spot": 214.30,
    "market_status": "closed",
    "quote_freshness": "stale_eod",
    "shape": "contango" | "backwardation" | "flat",
    "front_iv": 0.345,
    "back_iv": 0.380,
    "spread_vp": 3.5,
    "points": [
      {"expiration": "2026-05-29", "dte": 6, "strike": 200, "delta": -0.27, "iv": 0.345},
      ...
    ]
  }
"""

import json
import sys
from datetime import date

from _http_helper import list_option_expirations, polygon_get


def fetch_spot_info(symbol: str) -> tuple[float | None, str | None]:
    v3 = polygon_get("/v3/snapshot", {"ticker.any_of": symbol})
    if v3 and v3.get("status") == "OK" and v3.get("results"):
        r = v3["results"][0]
        price = (r.get("session") or {}).get("price")
        return (float(price) if price is not None else None, r.get("market_status"))
    return (None, None)


def freshness_from_status(market_status: str | None) -> str:
    return "live" if market_status in {"open", "regular"} else "stale_eod"


def fetch_side_for_exp(symbol: str, expiration: str, side: str) -> list[dict]:
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
    return [r for r in rows if r["delta"] is not None and r["iv"] is not None]


def closest_by_delta(rows: list[dict], target_abs: float) -> dict | None:
    if not rows:
        return None
    return min(rows, key=lambda r: abs(abs(r["delta"]) - target_abs))


def classify_shape(front_iv: float, back_iv: float) -> str:
    diff_vp = (back_iv - front_iv) * 100  # positive = back > front (contango)
    if abs(diff_vp) <= 1.0:
        return "flat"
    return "contango" if diff_vp > 0 else "backwardation"


def dte_for(exp_str: str) -> int:
    try:
        y, m, d = exp_str.split("-")
        target = date(int(y), int(m), int(d))
        return (target - date.today()).days
    except Exception:
        return -1


def main() -> None:
    if len(sys.argv) < 2:
        print(
            "usage: get_term_structure.py SYMBOL [TARGET_ABS_DELTA] [MAX_EXPIRATIONS] [put|call]",
            file=sys.stderr,
        )
        sys.exit(2)
    symbol = sys.argv[1].upper()
    target_abs = (float(sys.argv[2]) / 100.0) if len(sys.argv) > 2 and sys.argv[2].strip() else 0.50
    max_exps = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].strip() else 5
    side = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4].strip() else "put"
    if side not in ("put", "call"):
        side = "put"
    target_abs_pct = int(round(target_abs * 100))

    spot, market_status = fetch_spot_info(symbol)
    exps = list_option_expirations(symbol, side)
    # Keep only future expirations, take next N
    today_iso = date.today().isoformat()
    upcoming = [e for e in exps if e >= today_iso][:max_exps]

    points = []
    for exp in upcoming:
        rows = fetch_side_for_exp(symbol, exp, side)
        row = closest_by_delta(rows, target_abs)
        if row is None:
            continue
        points.append(
            {
                "expiration": exp,
                "dte": dte_for(exp),
                "strike": row["strike"],
                "delta": row["delta"],
                "iv": row["iv"],
            }
        )

    shape = None
    front_iv = None
    back_iv = None
    spread_vp = None
    if len(points) >= 2:
        front_iv = points[0]["iv"]
        back_iv = points[-1]["iv"]
        shape = classify_shape(front_iv, back_iv)
        spread_vp = round((back_iv - front_iv) * 100, 2)

    out = {
        "symbol": symbol,
        "target_abs_delta": target_abs_pct,
        "side": side,
        "spot": spot,
        "market_status": market_status,
        "quote_freshness": freshness_from_status(market_status),
        "shape": shape,
        "front_iv": front_iv,
        "back_iv": back_iv,
        "spread_vp": spread_vp,
        "points": points,
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
