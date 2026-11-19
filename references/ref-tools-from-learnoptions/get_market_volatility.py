#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Market-wide volatility / fear gauge.

Polygon's Indices subscription (which would give I:VIX directly) is sold
separately from Stocks. We approximate using two proxies that ARE in the
Stocks + Options product:

  1. VXX — iPath VIX Short-Term Futures ETN. Tracks VIX direction well;
     absolute level distorted by contango. We report price + intraday change.
  2. SPY front-month ATM IV — a defensible "synthetic VIX". VIX is defined as
     30-day implied vol on SPX; SPY's chain gives essentially the same IV.

Classification thresholds (synthetic VIX, applies to SPY ATM IV):
  <15%   : calm
  15-20% : normal
  20-25% : elevated
  25-30% : high
  >30%   : panic
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone


def timedelta_days(n: int) -> timedelta:
    return timedelta(days=n)


from _http_helper import polygon_get
from _time_helper import et_today


def fetch_prev_day(symbol: str) -> dict | None:
    data = polygon_get(f"/v2/aggs/ticker/{symbol}/prev")
    if not data or data.get("resultsCount", 0) == 0:
        return None
    r = data["results"][0]
    close = float(r["c"])
    open_ = float(r.get("o", close))
    return {
        "close": close,
        "open": open_,
        "high": float(r.get("h", 0)),
        "low": float(r.get("l", 0)),
        "change_pct": round((close - open_) / open_ * 100, 2) if open_ else 0,
        "as_of_ms": r.get("t"),
    }


def fetch_spy_atm_iv(target_dte_min: int = 21, target_dte_max: int = 45) -> dict | None:
    """Find SPY's ~30-day expiration, then return ATM IV.

    Implementation:
      1. Fetch SPY spot first (so we can target near-the-money strikes)
      2. List SPY contracts filtered by expiration_date.gte = today + target_dte_min
         and strike near spot (saves pagination headaches on the contracts endpoint)
      3. Pull the snapshot for the chosen expiration and extract ATM IV
    """
    today = et_today()  # DTE/到期窗口锚 ET 日历日(非 UTC)
    target_start = (today + timedelta_days(target_dte_min)).isoformat()
    target_end = (today + timedelta_days(target_dte_max)).isoformat()

    # Step 0: SPY spot
    spy_prev = fetch_prev_day("SPY")
    if not spy_prev:
        return None
    spot = spy_prev["close"]

    # Step 1: list contracts in the target window, filtered to strikes near spot
    # to avoid 1000-row pagination problem
    contracts = polygon_get(
        "/v3/reference/options/contracts",
        {
            "underlying_ticker": "SPY",
            "contract_type": "put",
            "expired": "false",
            "expiration_date.gte": target_start,
            "expiration_date.lte": target_end,
            "strike_price.gte": spot * 0.95,
            "strike_price.lte": spot * 1.05,
            "limit": 100,
            "order": "asc",
            "sort": "expiration_date",
        },
    )
    if not contracts or not contracts.get("results"):
        return None
    expirations = sorted(
        {
            r["expiration_date"]
            for r in contracts["results"]
            if r.get("expiration_date")
        }
    )
    if not expirations:
        return None
    chosen = expirations[0]
    chosen_dte = (datetime.strptime(chosen, "%Y-%m-%d").date() - today).days

    # Step 2: snapshot for that expiration (each side separately)
    snap_calls = polygon_get(
        "/v3/snapshot/options/SPY",
        {
            "expiration_date": chosen,
            "contract_type": "call",
            "strike_price.gte": spot * 0.95,
            "strike_price.lte": spot * 1.05,
            "limit": 50,
            "order": "asc",
            "sort": "strike_price",
        },
    )
    snap_puts = polygon_get(
        "/v3/snapshot/options/SPY",
        {
            "expiration_date": chosen,
            "contract_type": "put",
            "strike_price.gte": spot * 0.95,
            "strike_price.lte": spot * 1.05,
            "limit": 50,
            "order": "asc",
            "sort": "strike_price",
        },
    )
    if not snap_calls or not snap_puts:
        return None

    def nearest_atm(rows):
        best = None
        for r in rows:
            details = r.get("details", {})
            strike = details.get("strike_price")
            if strike is None:
                continue
            iv = r.get("implied_volatility")
            if iv is None:
                continue
            dist = abs(strike - spot)
            if best is None or dist < best[0]:
                best = (dist, strike, iv)
        return best

    call_atm = nearest_atm(snap_calls.get("results", []))
    put_atm = nearest_atm(snap_puts.get("results", []))

    if not call_atm and not put_atm:
        return None

    ivs = []
    if call_atm:
        ivs.append(call_atm[2])
    if put_atm:
        ivs.append(put_atm[2])
    avg_atm_iv = sum(ivs) / len(ivs) if ivs else None

    return {
        "expiration": chosen,
        "dte": chosen_dte,
        "spy_spot": spot,
        "atm_strike_call": call_atm[1] if call_atm else None,
        "atm_iv_call": call_atm[2] if call_atm else None,
        "atm_strike_put": put_atm[1] if put_atm else None,
        "atm_iv_put": put_atm[2] if put_atm else None,
        "synthetic_vix": avg_atm_iv,  # average of call+put ATM IV, as decimal
    }


def classify(synthetic_vix: float | None) -> dict:
    if synthetic_vix is None:
        return {"label": "unknown", "icon": "❔"}
    v_pct = synthetic_vix * 100
    if v_pct < 15:
        return {"label": "calm", "icon": "🟦"}
    if v_pct < 20:
        return {"label": "normal", "icon": "🟢"}
    if v_pct < 25:
        return {"label": "elevated", "icon": "🟡"}
    if v_pct < 30:
        return {"label": "high", "icon": "🟠"}
    return {"label": "panic", "icon": "🔴"}


def main() -> int:
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            f_vxx = ex.submit(fetch_prev_day, "VXX")
            f_spy_vol = ex.submit(fetch_spy_atm_iv)
            vxx = f_vxx.result()
            spy_vol = f_spy_vol.result()

        synthetic_vix = spy_vol["synthetic_vix"] if spy_vol else None
        regime = classify(synthetic_vix)

        out = {
            "as_of": datetime.now(timezone.utc).date().isoformat(),
            "vxx": vxx,
            "spy_synthetic_vix": spy_vol,
            "synthetic_vix_pct": (synthetic_vix * 100) if synthetic_vix else None,
            "regime": regime,
            "source": "polygon",
            "note": "Polygon Indices subscription is separate from Stocks; I:VIX is not accessible on this tier. VXX (ETN proxy, contango-affected) and SPY ATM IV (true VIX-equivalent) used instead.",
        }
        print(json.dumps(out))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
