#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.33.0", "python-dotenv>=1.0.0"]
# ///
"""Stock-specific volatility profile.

Combines:
  - Historical Volatility (HV) at 20d, 60d, 252d windows (annualized)
  - HV percentile rank vs the 252-day history (proxy for "IV rank")
  - Front-month ATM IV (true implied volatility from options chain)
  - IV / HV ratio = "premium richness"
  - Side-by-side range-based HV (Yang-Zhang OHLC, 10/20/60d; CBOE zero-mean
    close-to-close 20d; YZ ex-earnings) + IV / HV(YZ) — informational only,
    zero extra API calls (daily aggs already carry o/h/l/c)
  - Side-by-side constant-maturity ATM IV (CBOE VIX bracket + total-variance
    interpolation) at 30 calendar days and at --target-dte (default 14), so
    the IV/HV numerator no longer drifts with the calendar — informational,
    +2 API calls (one call + one put chain snapshot across the DTE window)
  - The per-expiry ATM IV ladder behind it (`atm_iv_by_expiry`, same two
    snapshots, zero extra calls) — compute_implied_move reads the target
    expiry's own IV from it

Algorithm:
  - Pull ~1.5y of daily bars (need 252 + ~252 buffer for percentile rank)
  - Compute log returns, then rolling std × sqrt(252) for HV
  - Pull front-month-ish chain (≥14 DTE), find ATM call+put, average IV

Polygon calls per run (measured live 2026-09-21, NVDA): 1 bars + 1 spot snapshot
+ 1 contracts listing + 2 front-month snapshots = 5 before; +2 constant-maturity
chain snapshots = 7 after (`api_calls_polygon` in the output counts them).
"""

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

import _http_helper
from _http_helper import polygon_get
from _time_helper import et_today


def fetch_daily_bars(symbol: str, days: int) -> list[dict]:
    now = datetime.now(timezone.utc).date()
    start = (now - timedelta(days=int(days * 1.6))).isoformat()
    data = polygon_get(
        f"/v2/aggs/ticker/{symbol}/range/1/day/{start}/{now.isoformat()}",
        {"adjusted": "true", "sort": "asc", "limit": 5000},
    )
    if not data or not data.get("results"):
        return []
    return data["results"][-days:] if len(data["results"]) > days else data["results"]


def fetch_spot_universal(symbol: str) -> tuple[float | None, str | None]:
    """Latest cross-session spot via /v3/snapshot Universal — matches get_chain
    so all wheel tools see the same spot in one turn. Falls back to /v2/aggs/prev.

    Returns (spot, source_label). The source_label lets the caller note that HV
    (from daily closes, regular-session) and spot (now cross-session including
    pre/post-market) are on slightly different time bases — small drift on news
    days but otherwise negligible.
    """
    v3 = polygon_get("/v3/snapshot", {"ticker.any_of": symbol})
    if v3 and v3.get("status") == "OK" and v3.get("results"):
        r = v3["results"][0]
        price = (r.get("session") or {}).get("price")
        if price is not None:
            return (float(price), "v3_snapshot_universal")
    fallback = polygon_get(f"/v2/aggs/ticker/{symbol}/prev")
    if fallback and fallback.get("resultsCount", 0):
        return (float(fallback["results"][0]["c"]), "v2_aggs_prev_fallback")
    return (None, None)


def stddev(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / (n - 1)  # sample std for HV
    return math.sqrt(var)


def log_returns(closes: list[float]) -> list[float]:
    return [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]


def rolling_hv(returns: list[float], window: int) -> list[float | None]:
    """Annualized HV at each point. Returns None until enough history."""
    out: list[float | None] = []
    sqrt_year = math.sqrt(252)
    for i in range(len(returns)):
        if i + 1 < window:
            out.append(None)
            continue
        w = returns[i + 1 - window : i + 1]
        out.append(stddev(w) * sqrt_year)
    return out


def hv_excluding(
    returns: list[float], excluded: set[int], window: int
) -> float | None:
    """Annualized HV over the last `window` NON-excluded returns — the
    ORATS orHvXern idea: earnings-day distortions removed so the baseline
    reflects normal movement. None when not enough clean returns remain."""
    clean = [r for i, r in enumerate(returns) if i not in excluded]
    if len(clean) < window:
        return None
    return stddev(clean[-window:]) * math.sqrt(252)


# ── range-based estimators (BACKLOG hv-range-estimators) ─────────────────────
# 并排口径,不动上面的 close-to-close 路径。Polygon 日线 aggs 本就带 o/h/l/c,
# 零新增 fetch。digest 2026-09-19 §4:20 日 close-to-close HV 窗口间 stdev ≈ 6.3
# 点,比 classify_iv_hv_ratio 的 0.15 档宽还大;Yang-Zhang 方差降 ~7.5× 且含
# 隔夜跳空项(Parkinson / Rogers-Satchell 不含 → 跳空单票低估 ~13 点,所以只上 YZ)。


def cc_zero_mean_hv(returns: list[float]) -> float | None:
    """CBOE RVOL 口径:对数收益、均值设零、除以 N(非 n−1)、×√252。
    与 stddev() 的差别在 20 日窗口下 <0.5 点 —— 采纳理由是与 RVOL /
    variance-swap 同口径的可比性,不是精度。空序列 → None。"""
    n = len(returns)
    if n == 0:
        return None
    return math.sqrt(sum(r * r for r in returns) / n) * math.sqrt(252)


# 一个 YZ 观测 = (ln O_t/C_{t−1}, ln C_t/O_t, RS 项);索引与 log_returns 对齐
# (obs[i] 描述 bars[i+1] 那一天,前收 = bars[i]["c"]),所以 earnings_exclusion_indices
# 给出的排除集可以原样复用。
YZObs = tuple[float, float, float]


def yz_observations(bars: list[dict]) -> list[YZObs | None]:
    """每根 bar 的三个 YZ 分量;bar 缺 o/h/l/c 任一或值非正 → 该观测 None
    (不抛异常,让窗口层降级),前收缺失同理。"""
    out: list[YZObs | None] = []
    for i in range(1, len(bars)):
        prev_c = bars[i - 1].get("c")
        b = bars[i]
        o, h, l, c = b.get("o"), b.get("h"), b.get("l"), b.get("c")
        vals = (prev_c, o, h, l, c)
        if any(v is None for v in vals) or any(float(v) <= 0 for v in vals):
            out.append(None)
            continue
        prev_c, o, h, l, c = (float(v) for v in vals)
        o_ret = math.log(o / prev_c)
        c_ret = math.log(c / o)
        rs = math.log(h / c) * math.log(h / o) + math.log(l / c) * math.log(l / o)
        out.append((o_ret, c_ret, rs))
    return out


def yang_zhang_hv(obs: list[YZObs]) -> float | None:
    """Yang & Zhang (2000, SSRN 229190) 年化 HV:
    σ²_YZ = σ²_o + k·σ²_c + (1−k)·σ²_RS,σ²_o / σ²_c 为样本方差(n−1),
    σ²_RS = (1/n) Σ[ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O)],
    k = 0.34 / (1.34 + (n+1)/(n−1))。n < 2 → None。"""
    n = len(obs)
    if n < 2:
        return None
    var_o = stddev([x[0] for x in obs]) ** 2
    var_c = stddev([x[1] for x in obs]) ** 2
    var_rs = sum(x[2] for x in obs) / n
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    var_yz = var_o + k * var_c + (1 - k) * var_rs
    if var_yz < 0:  # RS 项在极端 bar 上可为负;方差不能负 → 降级
        return None
    return math.sqrt(var_yz) * math.sqrt(252)


def rolling_yz_hv(obs: list[YZObs | None], window: int) -> list[float | None]:
    """与 rolling_hv 同形:每个位置给最近 `window` 个观测的 YZ HV;观测不足
    或窗口内含 None(缺 o/h/l 的 bar)→ None,不用部分窗口凑数。"""
    out: list[float | None] = []
    for i in range(len(obs)):
        if i + 1 < window:
            out.append(None)
            continue
        w = obs[i + 1 - window : i + 1]
        if any(x is None for x in w):
            out.append(None)
            continue
        out.append(yang_zhang_hv([x for x in w if x is not None]))
    return out


def yz_hv_excluding(
    obs: list[YZObs | None], excluded: set[int], window: int
) -> float | None:
    """hv_excluding 的 YZ 版:最近 `window` 个未排除观测;干净观测不足或
    其中含 None → None。"""
    clean = [x for i, x in enumerate(obs) if i not in excluded]
    if len(clean) < window:
        return None
    w = clean[-window:]
    if any(x is None for x in w):
        return None
    return yang_zhang_hv([x for x in w if x is not None])


def earnings_exclusion_indices(
    bar_dates: list[str], earnings_dates: list[str]
) -> set[int]:
    """Map earnings dates → return indices to exclude. Return i spans
    bar_dates[i] → bar_dates[i+1]. For each earnings date we exclude the
    returns ENDING on the first trading day ≥ that date and the day after —
    covers both BMO and AMC reporting without time-of-day info, plus the
    follow-through day."""
    excluded: set[int] = set()
    n = len(bar_dates)
    for ed in earnings_dates:
        k = None
        for j, d in enumerate(bar_dates):
            if d >= ed:
                k = j
                break
        if k is None:
            continue  # earnings after the last bar — nothing to exclude yet
        for ret_idx in (k - 1, k):  # returns ending at bars k and k+1
            if 0 <= ret_idx < n - 1:
                excluded.add(ret_idx)
    return excluded


def fetch_past_earnings_dates(symbol: str, frm: str, to: str) -> list[str] | None:
    """Past earnings dates from Finnhub's calendar. None on ANY failure —
    callers degrade the xern fields to null, never guess."""
    key = os.getenv("FINNHUB_API_KEY")
    if not key:
        return None
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/calendar/earnings",
            params={"from": frm, "to": to, "symbol": symbol, "token": key},
            timeout=15,
        )
        if resp.status_code != 200:
            return None
        rows = (resp.json() or {}).get("earningsCalendar") or []
        return sorted({r.get("date") for r in rows if r.get("date")})
    except requests.RequestException:
        return None


def percentile_rank(value: float, series: list[float]) -> float:
    if not series:
        return 0.0
    n_below = sum(1 for x in series if x < value)
    return n_below / len(series)


def nearest_atm(rows: list[dict], spot: float) -> tuple[float, float, float] | None:
    """Snapshot rows → (distance, strike, iv) of the strike nearest to spot
    (rows without strike or IV skipped). Shared by the front-month path and
    the per-expiry constant-maturity path so both pick ATM the same way."""
    best = None
    for r in rows:
        strike = (r.get("details") or {}).get("strike_price")
        iv = r.get("implied_volatility")
        if strike is None or iv is None:
            continue
        dist = abs(strike - spot)
        if best is None or dist < best[0]:
            best = (dist, strike, iv)
    return best


def fetch_front_month_atm_iv(
    symbol: str, spot: float, target_dte_min: int = 14, target_dte_max: int = 45
) -> dict | None:
    today = et_today()  # DTE/到期窗口锚 ET 日历日(非 UTC)
    target_start = (today + timedelta(days=target_dte_min)).isoformat()
    target_end = (today + timedelta(days=target_dte_max)).isoformat()

    # List eligible contracts in narrow strike+date window
    contracts = polygon_get(
        "/v3/reference/options/contracts",
        {
            "underlying_ticker": symbol,
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
        {r["expiration_date"] for r in contracts["results"] if r.get("expiration_date")}
    )
    if not expirations:
        return None
    chosen = expirations[0]
    chosen_dte = (datetime.strptime(chosen, "%Y-%m-%d").date() - today).days

    snap_calls = polygon_get(
        f"/v3/snapshot/options/{symbol}",
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
        f"/v3/snapshot/options/{symbol}",
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

    call_atm = nearest_atm(snap_calls.get("results", []), spot)
    put_atm = nearest_atm(snap_puts.get("results", []), spot)

    ivs = []
    if call_atm:
        ivs.append(call_atm[2])
    if put_atm:
        ivs.append(put_atm[2])
    avg = sum(ivs) / len(ivs) if ivs else None

    return {
        "expiration": chosen,
        "dte": chosen_dte,
        "atm_strike_call": call_atm[1] if call_atm else None,
        "atm_iv_call": call_atm[2] if call_atm else None,
        "atm_strike_put": put_atm[1] if put_atm else None,
        "atm_iv_put": put_atm[2] if put_atm else None,
        "atm_iv_avg": avg,
    }


def classify_iv_hv_ratio(ratio: float | None) -> dict:
    if ratio is None:
        return {"label": "unknown", "icon": "❔"}
    if ratio < 0.85:
        return {
            "label": "cheap",
            "icon": "💎",
            "note": "IV < realized — selling premium underpays for the risk. Rare; favor buying premium / debit spreads.",
        }
    if ratio < 1.0:
        return {
            "label": "slightly_cheap",
            "icon": "🟦",
            "note": "IV slightly below realized vol — premium isn't exciting for sellers.",
        }
    if ratio < 1.15:
        return {
            "label": "fair",
            "icon": "🟢",
            "note": "IV ≈ realized vol — fair premium, standard market state.",
        }
    if ratio < 1.4:
        return {
            "label": "rich",
            "icon": "🟡",
            "note": "IV materially above realized — typical short-premium environment.",
        }
    return {
        "label": "very_rich",
        "icon": "🔥",
        "note": "IV ≫ realized — premium very rich, but often signals upcoming event/catalyst. Verify what's priced in.",
    }


# ── constant-maturity ATM IV (BACKLOG iv-constant-maturity-atm) ──────────────
# 并排口径,不动上面的 front-month 路径。现状分子取 DTE ∈ [14, 45] 内最早到期,
# 期限随日历漂(周权票 14–20 天、月权票可到 45 天),分母却恒为 HV20 ≈ 一个月;
# ORATS ivHvXernRatio / CBOE VIX 都把分子钉在 30 日常数期限。做法 = CBOE VIX
# Mathematics Methodology §3(b):在总方差 T·σ² 上对两个夹住目标的到期线性插值,
# 再除以目标期限;夹不住(无 ≤ 目标的到期 / 只剩一个到期 / T2 == T1)一律
# nearest_term_fallback 明标,**不外推**(外推可得负方差)。
CM_DAYS_30 = 30
CM_TARGET_DTE_DEFAULT = 14  # theta 7–14 DTE 风格上界;CLI --target-dte 可改
CM_DTE_FLOOR = 1  # 0DTE 不进 bracket
CM_WINDOW_SLACK_DAYS = 35  # near 之后的 next 最多一个月权周期远
CM_STRIKE_BAND = 0.05  # 与 front-month 路径同一 ±5% strike 窗,ATM 取法一致
CM_INTERPOLATED = "interpolated"
CM_FALLBACK = "nearest_term_fallback"


def interpolate_constant_maturity_var(
    t1: float, s1: float, t2: float, s2: float, t_cm: float
) -> float | None:
    """CBOE VIX §3(b) 常数期限:σ_CM² = [T1·σ1²·(T2−T_CM)/(T2−T1) + T2·σ2²·(T_CM−T1)/(T2−T1)] / T_CM,
    T 以年计(DTE/365)。返回 σ_CM(总方差插值后开方)。T_CM 不在 [T1, T2] 内、
    T2 ≤ T1、T_CM ≤ 0 → None(不外推、不除零)。"""
    if t_cm <= 0 or t2 <= t1 or not (t1 <= t_cm <= t2):
        return None
    w1 = (t2 - t_cm) / (t2 - t1)
    w2 = (t_cm - t1) / (t2 - t1)
    total_var = t1 * s1 * s1 * w1 + t2 * s2 * s2 * w2
    return math.sqrt(total_var / t_cm)


def bracket_constant_maturity(expiry_ivs: list[dict], target_dte: int) -> dict | None:
    """CBOE bracket:near = DTE ≤ target 的最近到期(≥ 1 DTE),next = 其后第一个到期,
    两者夹住目标则插值;否则 nearest_term_fallback = 离目标最近的到期 ATM IV,
    next_* 置 None 明标非插值。expiry_ivs 元素 {expiration, dte, atm_iv_avg};
    dte < 1 或 atm_iv_avg 为 None 的行忽略;无可用行 → None。"""
    usable = sorted(
        (e for e in expiry_ivs if e.get("atm_iv_avg") is not None and (e.get("dte") or 0) >= CM_DTE_FLOOR),
        key=lambda e: (e["dte"], e["expiration"]),
    )
    if not usable:
        return None
    near = None
    for e in usable:
        if e["dte"] <= target_dte:
            near = e
    nxt = None
    if near is not None:
        nxt = next((e for e in usable if e["dte"] > near["dte"]), None)
    if near is not None and nxt is not None:
        sigma = interpolate_constant_maturity_var(
            near["dte"] / 365.0, near["atm_iv_avg"], nxt["dte"] / 365.0, nxt["atm_iv_avg"], target_dte / 365.0
        )
        if sigma is not None:
            return {
                "value": sigma,
                "target_dte": target_dte,
                "near_expiry": near["expiration"],
                "near_dte": near["dte"],
                "next_expiry": nxt["expiration"],
                "next_dte": nxt["dte"],
                "method": CM_INTERPOLATED,
            }
    closest = min(usable, key=lambda e: (abs(e["dte"] - target_dte), e["dte"]))
    return {
        "value": closest["atm_iv_avg"],
        "target_dte": target_dte,
        "near_expiry": closest["expiration"],
        "near_dte": closest["dte"],
        "next_expiry": None,
        "next_dte": None,
        "method": CM_FALLBACK,
    }


def atm_iv_by_expiry_from_rows(
    call_rows: list[dict], put_rows: list[dict], spot: float, today, truncated: bool
) -> list[dict]:
    """快照行按到期分组,每个到期用 nearest_atm(同 front-month 取法)取 ATM call/put
    并平均 → 升序 [{expiration, dte, atm_iv_call, atm_iv_put, atm_iv_avg}]。
    truncated=True(快照分页被截断)→ 丢掉最后一个到期组:它可能只拿到一半 strike,
    nearest 会选错。"""
    by_exp: dict[str, tuple[list[dict], list[dict]]] = {}
    for rows, side in ((call_rows, 0), (put_rows, 1)):
        for r in rows:
            exp = (r.get("details") or {}).get("expiration_date")
            if not exp:
                continue
            by_exp.setdefault(exp, ([], []))[side].append(r)
    expirations = sorted(by_exp)
    if truncated and expirations:
        expirations = expirations[:-1]
    out: list[dict] = []
    for exp in expirations:
        calls, puts = by_exp[exp]
        c_atm = nearest_atm(calls, spot)
        p_atm = nearest_atm(puts, spot)
        ivs = [x[2] for x in (c_atm, p_atm) if x]
        out.append(
            {
                "expiration": exp,
                "dte": (datetime.strptime(exp, "%Y-%m-%d").date() - today).days,
                "atm_iv_call": c_atm[2] if c_atm else None,
                "atm_iv_put": p_atm[2] if p_atm else None,
                "atm_iv_avg": sum(ivs) / len(ivs) if ivs else None,
            }
        )
    return out


def fetch_atm_iv_by_expiry(symbol: str, spot: float, dte_min: int, dte_max: int) -> list[dict] | None:
    """2 Polygon 请求(call + put 链快照,DTE ∈ [dte_min, dte_max]、strike ±5%、
    limit 250、按到期升序)→ atm_iv_by_expiry_from_rows。任一侧失败 → None。"""
    today = et_today()  # DTE/到期窗口锚 ET 日历日(非 UTC)
    common = {
        "expiration_date.gte": (today + timedelta(days=dte_min)).isoformat(),
        "expiration_date.lte": (today + timedelta(days=dte_max)).isoformat(),
        "strike_price.gte": spot * (1 - CM_STRIKE_BAND),
        "strike_price.lte": spot * (1 + CM_STRIKE_BAND),
        "limit": 250,
        "order": "asc",
        "sort": "expiration_date",
    }
    snaps = []
    for contract_type in ("call", "put"):
        snap = polygon_get(f"/v3/snapshot/options/{symbol}", {**common, "contract_type": contract_type})
        if not snap:
            return None
        snaps.append(snap)
    truncated = any(bool(s.get("next_url")) for s in snaps)
    return atm_iv_by_expiry_from_rows(
        snaps[0].get("results", []), snaps[1].get("results", []), spot, today, truncated
    )


def selftest() -> int:
    """Offline fixtures for the ex-earnings HV logic (no network).
    Wrapped into smoke:all by scripts/smoke-volatility-xern.ts."""
    failures = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal failures
        if not cond:
            failures += 1
            print(f"  FAIL: {msg}")

    sqrt_year = math.sqrt(252)
    # Alternating baseline with one 10σ-style spike at index 30 (+ follow-through 31).
    rets = [0.01 if i % 2 == 0 else -0.012 for i in range(40)]
    rets[30] = 0.12
    rets[31] = -0.05

    # Spike inside the window, excluded → equals an INDEPENDENT manual filter.
    got = hv_excluding(rets, {30, 31}, 20)
    manual = [r for i, r in enumerate(rets) if i not in (30, 31)][-20:]
    check(got is not None and abs(got - stddev(manual) * sqrt_year) < 1e-12, "xern == manual-filtered window")
    plain = rolling_hv(rets, 20)[-1]
    check(got is not None and plain is not None and got < plain, "excluding the spike lowers HV")
    # Exclusion fully OUTSIDE the trailing window → identical to plain.
    early = hv_excluding(rets, {0, 1}, 20)
    check(early is not None and plain is not None and abs(early - plain) < 1e-12, "out-of-window exclusion → equals plain HV")
    # Empty exclusion → identical to plain.
    none_ex = hv_excluding(rets, set(), 20)
    check(none_ex is not None and abs(none_ex - plain) < 1e-12, "empty exclusion → equals plain HV")
    # Not enough clean returns → None, never a tiny-sample number.
    check(hv_excluding(rets[:21], set(range(5)), 20) is None, "insufficient clean returns → None")
    print("hv_excluding ok")

    # Date mapping: bars Mon..Fri x2 weeks; earnings Wed (idx 2) AMC.
    bar_dates = [
        "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
        "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
    ]
    # Earnings ON a trading day: exclude returns ending that day and the next.
    check(earnings_exclusion_indices(bar_dates, ["2026-06-03"]) == {1, 2}, "trading-day earnings → returns ending d and d+1")
    # Earnings on a weekend (Sat 06-06) → first bar ≥ date is Mon 06-08 (idx 5).
    check(earnings_exclusion_indices(bar_dates, ["2026-06-06"]) == {4, 5}, "weekend earnings → next trading day's returns")
    # Earnings after the last bar → nothing; before the first bar → clamps.
    check(earnings_exclusion_indices(bar_dates, ["2026-07-01"]) == set(), "future earnings → empty")
    check(earnings_exclusion_indices(bar_dates, ["2026-05-01"]) == {0}, "pre-history earnings → clamps to first return only")
    check(earnings_exclusion_indices(bar_dates, []) == set(), "no earnings → empty")
    print("exclusion_indices ok")

    # Degradation: the main flow turns earnings=None into null xern fields —
    # assert the helper contract that feeds it (None ≠ empty list).
    check(fetch_past_earnings_dates.__doc__ is not None, "degradation contract documented")
    print("degradation ok")

    # ── range-based estimators (BACKLOG hv-range-estimators) ──────────────
    # ① CBOE zero-mean close-to-close: on a Σr = 0 series it must equal the
    #    sample stddev rescaled by sqrt((n−1)/n) — an exact identity.
    zm = [0.01, -0.01, 0.02, -0.02, 0.015, -0.015]
    got_zm = cc_zero_mean_hv(zm)
    exp_zm = stddev(zm) * math.sqrt((len(zm) - 1) / len(zm)) * sqrt_year
    check(got_zm is not None and abs(got_zm - exp_zm) < 1e-12, "cc_zero_mean == stddev × sqrt((n−1)/n) on Σr=0")
    check(cc_zero_mean_hv([]) is None, "cc_zero_mean empty → None")
    print("cc_zero_mean ok")

    # ② Yang-Zhang hand-calc golden: 5 synthetic OHLC bars after a prior close
    #    of 100. σ_o²/σ_c²/σ_RS²/k were computed independently (throwaway
    #    script, statistics.variance) → hv_yz = 0.31722089550468646.
    yz_bars = [
        {"c": 100.0},
        {"o": 101.0, "h": 103.0, "l": 100.0, "c": 102.0},
        {"o": 101.5, "h": 104.0, "l": 101.0, "c": 103.0},
        {"o": 104.0, "h": 105.0, "l": 102.0, "c": 102.5},
        {"o": 102.0, "h": 103.0, "l": 99.0, "c": 100.0},
        {"o": 100.5, "h": 102.0, "l": 100.0, "c": 101.5},
    ]
    obs = yz_observations(yz_bars)
    check(len(obs) == 5 and all(o is not None for o in obs), "5 bars after prior close → 5 observations")
    got_yz = yang_zhang_hv(obs)
    check(got_yz is not None and abs(got_yz - 0.31722089550468646) < 1e-9, "YZ golden (hand-calc) == 0.317220896")
    k5 = 0.34 / (1.34 + (5 + 1) / (5 - 1))

    # ③ Degenerate identity: no overnight gap (O_t = C_{t−1}) and no intraday
    #    range beyond O..C (H = max, L = min) → σ_o² = 0, σ_RS² = 0, so
    #    σ_YZ² = k·σ_c² with σ_c² = close-to-close sample variance.
    degen_closes = [100.0, 102.0, 101.0, 104.0, 103.0, 105.0]
    degen_bars = [{"c": degen_closes[0]}]
    for i in range(1, len(degen_closes)):
        o, c = degen_closes[i - 1], degen_closes[i]
        degen_bars.append({"o": o, "h": max(o, c), "l": min(o, c), "c": c})
    cc_sample = stddev(log_returns(degen_closes)) * sqrt_year
    got_degen = yang_zhang_hv(yz_observations(degen_bars))
    check(got_degen is not None and abs(got_degen - math.sqrt(k5) * cc_sample) < 1e-9, "no-gap/no-range → hv_yz == sqrt(k) × cc_sample")

    # ④ RED fixture — pure overnight gaps: all movement is O_t vs C_{t−1},
    #    intraday H = L = O = C. σ_c² = σ_RS² = 0, σ_o² = close-to-close sample
    #    variance → hv_yz == cc_sample. A Parkinson/RS swap would read 0 here
    #    (the ~13-pt gap-stock underestimate from digest §4 C) — this pins YZ.
    gap_closes = [100.0, 103.0, 99.0, 104.0, 101.0, 106.0]
    gap_bars = [{"c": gap_closes[0]}] + [{"o": x, "h": x, "l": x, "c": x} for x in gap_closes[1:]]
    got_gap = yang_zhang_hv(yz_observations(gap_bars))
    gap_cc = stddev(log_returns(gap_closes)) * sqrt_year
    check(got_gap is not None and abs(got_gap - gap_cc) < 1e-9, "pure overnight gaps → hv_yz == cc_sample")
    parkinson_sum = sum(math.log(b["h"] / b["l"]) ** 2 for b in gap_bars[1:])
    check(parkinson_sum == 0.0 and got_gap > 0.0, "same input: Parkinson component is exactly 0 while YZ is not")
    print("yang_zhang ok")

    # ⑤ Guards: too few observations → None; a bar missing any of o/h/l (or
    #    non-positive) → that window None; the plain close-only path is untouched.
    check(all(v is None for v in rolling_yz_hv(obs, 20)), "obs < window → all None")
    check(rolling_yz_hv(obs, 5)[-1] is not None and rolling_yz_hv(obs, 5)[-2] is None, "window boundary: first value at index window−1")
    hole_bars = [dict(b) for b in yz_bars]
    del hole_bars[3]["h"]
    hole_obs = yz_observations(hole_bars)
    check(hole_obs[2] is None and sum(o is None for o in hole_obs) == 1, "missing h → exactly that observation None")
    check(rolling_yz_hv(hole_obs, 3)[-1] is None and rolling_yz_hv(hole_obs, 2)[-1] is not None, "window containing the hole → None; later clean window → value")
    check(yz_observations([{"c": 100.0}, {"o": 0.0, "h": 1.0, "l": 1.0, "c": 1.0}])[0] is None, "non-positive price → None, no exception")
    check(yang_zhang_hv([]) is None and yang_zhang_hv(obs[:1]) is None, "n < 2 → None")
    plain_hole = rolling_hv(log_returns([b["c"] for b in hole_bars]), 3)[-1]
    check(plain_hole is not None and plain_hole > 0, "plain close-to-close HV unaffected by missing o/h/l")
    print("yz_guards ok")

    # ⑥ xern consistency: exclusion fully outside the window → equals plain YZ;
    #    exclusion inside → equals an INDEPENDENT manual filter.
    long_bars = [{"c": 100.0}]
    px = 100.0
    for i in range(30):
        o = px * (1.004 if i % 3 == 0 else 0.997)
        c = o * (1.012 if i % 2 == 0 else 0.99)
        long_bars.append({"o": o, "h": max(o, c) * 1.006, "l": min(o, c) * 0.995, "c": c})
        px = c
    long_obs = yz_observations(long_bars)
    plain_yz20 = rolling_yz_hv(long_obs, 20)[-1]
    check(plain_yz20 is not None, "30 clean observations → hv_20_yz present")
    out_ex = yz_hv_excluding(long_obs, {0, 1}, 20)
    check(out_ex is not None and abs(out_ex - plain_yz20) < 1e-12, "out-of-window exclusion → equals plain YZ")
    in_ex = yz_hv_excluding(long_obs, {25, 26}, 20)
    manual_obs = [o for i, o in enumerate(long_obs) if i not in (25, 26)][-20:]
    check(in_ex is not None and abs(in_ex - yang_zhang_hv(manual_obs)) < 1e-12, "in-window exclusion == manual-filtered YZ")
    check(yz_hv_excluding(long_obs[:21], set(range(5)), 20) is None, "insufficient clean observations → None")
    print("yz_xern ok")

    # ── constant-maturity ATM IV (BACKLOG iv-constant-maturity-atm) ─────────
    # ① endpoint identity / ② hand-calc golden / ③ flat surface / ⑤ squeeze /
    #    no-extrapolation + degenerate guards — all on the pure interpolator.
    Y = 365.0
    cm = interpolate_constant_maturity_var
    check(abs(cm(14 / Y, 0.50, 42 / Y, 0.40, 14 / Y) - 0.50) < 1e-12, "T_CM == T1 → σ_CM == σ1")
    check(abs(cm(14 / Y, 0.50, 42 / Y, 0.40, 42 / Y) - 0.40) < 1e-12, "T_CM == T2 → σ_CM == σ2")
    # Golden (spec hand-calc): V = 14/365·0.25·(12/28) + 42/365·0.16·(16/28) ≈ 0.014630,
    # σ_CM = sqrt(V / (30/365)) = 0.4219 (4 dp).
    golden = cm(14 / Y, 0.50, 42 / Y, 0.40, 30 / Y)
    check(golden is not None and round(golden, 4) == 0.4219, "hand-calc golden σ_CM(30d) == 0.4219")
    v_total = (14 / Y) * 0.25 * (12 / 28) + (42 / Y) * 0.16 * (16 / 28)
    check(golden is not None and abs(golden - math.sqrt(v_total / (30 / Y))) < 1e-12, "σ_CM == sqrt(interpolated total variance / T_CM)")
    for t in (14, 15.5, 20, 30, 41.9, 42):
        check(abs(cm(14 / Y, 0.33, 42 / Y, 0.33, t / Y) - 0.33) < 1e-12, f"flat surface σ1==σ2 → σ_CM == σ at T_CM={t}d")
    for s1, s2 in ((0.50, 0.40), (0.40, 0.50)):
        for t in range(14, 43):
            v = cm(14 / Y, s1, 42 / Y, s2, t / Y)
            check(v is not None and min(s1, s2) - 1e-12 <= v <= max(s1, s2) + 1e-12, f"squeeze σ_CM ∈ [min,max] at {t}d ({s1},{s2})")
    check(cm(14 / Y, 0.5, 42 / Y, 0.4, 10 / Y) is None, "T_CM < T1 → None (no extrapolation)")
    check(cm(14 / Y, 0.5, 42 / Y, 0.4, 50 / Y) is None, "T_CM > T2 → None (no extrapolation)")
    check(cm(14 / Y, 0.5, 14 / Y, 0.4, 14 / Y) is None, "T2 == T1 → None, no ZeroDivisionError")
    check(cm(42 / Y, 0.5, 14 / Y, 0.4, 30 / Y) is None, "T2 < T1 → None")
    check(cm(0.0, 0.5, 42 / Y, 0.4, 0.0) is None, "T_CM == 0 → None, no ZeroDivisionError")
    # 日历口径 golden 锁现状(BACKLOG constant-maturity-iv-trading-clock ①;交易日口径在 TS 侧
    # app/src/lib/cm-trading-clock.ts,smoke-cm-trading-clock.ts 断言):as-of 周一、目标 14d、
    # 腿 11d/18d(交易日 σ=40%、w=0 正向生成)→ 日历插值 0.429478。
    cal_golden = cm(11 / Y, 0.435443, 18 / Y, 0.424555, 14 / Y)
    check(cal_golden is not None and abs(cal_golden - 0.429478) < 1e-5, "calendar-clock golden (Mon as-of, 14d, 11d↔18d legs) == 0.429478")
    print("cm_interp ok")

    # ④ bracket three-state fallback + interpolated path on synthetic expiry
    #    ladders (dte, atm_iv_avg); expiration strings are labels only.
    def ladder(pairs):
        return [{"expiration": f"E{d}", "dte": d, "atm_iv_avg": iv} for d, iv in pairs]

    weekly = ladder([(2, 0.60), (9, 0.55), (16, 0.50), (23, 0.47), (28, 0.46), (35, 0.44), (63, 0.42)])
    b30 = bracket_constant_maturity(weekly, 30)
    check(b30 is not None and b30["method"] == "interpolated", "weekly ladder → 30d interpolated")
    check(b30 is not None and (b30["near_dte"], b30["next_dte"]) == (28, 35), "30d bracket = 28d ↔ 35d (nearest ≤ target, first after)")
    check(b30 is not None and (b30["near_expiry"], b30["next_expiry"]) == ("E28", "E35"), "bracket carries both expiration labels")
    check(b30 is not None and abs(b30["value"] - cm(28 / Y, 0.46, 35 / Y, 0.44, 30 / Y)) < 1e-12, "30d value == pure interpolator on the bracket legs")
    check(b30 is not None and 0.44 <= b30["value"] <= 0.46, "30d value squeezed between the legs")
    b14 = bracket_constant_maturity(weekly, 14)
    check(b14 is not None and b14["method"] == "interpolated" and (b14["near_dte"], b14["next_dte"]) == (9, 16), "14d bracket = 9d ↔ 16d")
    on_expiry = bracket_constant_maturity(ladder([(16, 0.50), (30, 0.45), (37, 0.44)]), 30)
    check(on_expiry is not None and on_expiry["method"] == "interpolated" and abs(on_expiry["value"] - 0.45) < 1e-12, "target lands on an expiry → value == that expiry's IV, still 'interpolated'")
    # fallback ①: no expiry with dte ≤ target → nearest term, marked
    far = bracket_constant_maturity(ladder([(35, 0.44), (63, 0.42)]), 30)
    check(far is not None and far["method"] == "nearest_term_fallback" and abs(far["value"] - 0.44) < 1e-12, "no dte ≤ target → nearest_term_fallback, value == nearest expiry IV")
    check(far is not None and far["near_dte"] == 35 and far["next_expiry"] is None and far["next_dte"] is None, "fallback names the expiry used and leaves next_* null")
    # fallback ②: only one expiry
    single = bracket_constant_maturity(ladder([(25, 0.47)]), 30)
    check(single is not None and single["method"] == "nearest_term_fallback" and abs(single["value"] - 0.47) < 1e-12, "single expiry → fallback, value == its IV")
    # fallback ③: T2 == T1 (duplicate expiry rows) → no division by zero
    dup = bracket_constant_maturity(ladder([(25, 0.47), (25, 0.48)]), 30)
    check(dup is not None and dup["method"] == "nearest_term_fallback", "duplicate dte (T2 == T1) → fallback, no ZeroDivisionError")
    # guards: empty / null IV / dte < 1 filtered out
    check(bracket_constant_maturity([], 30) is None, "empty ladder → None")
    check(bracket_constant_maturity(ladder([(0, 0.9), (28, None)]), 30) is None, "0DTE and null-IV rows ignored → None")
    skip = bracket_constant_maturity(ladder([(0, 0.9), (28, None), (30, 0.45), (37, 0.44)]), 30)
    check(skip is not None and skip["near_dte"] == 30 and abs(skip["value"] - 0.45) < 1e-12, "0DTE / null-IV rows skipped, bracket from the rest")
    print("cm_bracket ok")

    # per-expiry ATM grouping from raw snapshot rows: same nearest-strike rule
    # as the front-month path, per expiry (grids may differ across expiries);
    # a truncated page drops the LAST (possibly partial) expiry group.
    def row(exp, strike, iv):
        return {"details": {"expiration_date": exp, "strike_price": strike}, "implied_volatility": iv}

    today = datetime(2026, 9, 21).date()
    calls = [row("2026-10-02", 225.0, 0.50), row("2026-10-02", 227.5, 0.48), row("2026-10-16", 225.0, 0.46), row("2026-10-16", 230.0, 0.45), row("2026-11-20", 225.0, 0.43)]
    puts = [row("2026-10-02", 225.0, 0.52), row("2026-10-02", 227.5, 0.50), row("2026-10-16", 225.0, 0.47), row("2026-10-16", 230.0, 0.46), row("2026-11-20", 225.0, 0.44)]
    grouped = atm_iv_by_expiry_from_rows(calls, puts, 226.0, today, truncated=False)
    check([g["expiration"] for g in grouped] == ["2026-10-02", "2026-10-16", "2026-11-20"], "grouped by expiry, ascending")
    check([g["dte"] for g in grouped] == [11, 25, 60], "dte from expiration vs today")
    check(abs(grouped[0]["atm_iv_avg"] - (0.50 + 0.52) / 2) < 1e-12, "10-02 ATM = 225 strike (nearest on $2.5 grid) call+put avg")
    check(abs(grouped[1]["atm_iv_avg"] - (0.46 + 0.47) / 2) < 1e-12, "10-16 ATM = 225 strike (nearest on $5 grid)")
    trunc = atm_iv_by_expiry_from_rows(calls, puts, 226.0, today, truncated=True)
    check([g["expiration"] for g in trunc] == ["2026-10-02", "2026-10-16"], "truncated page → last expiry group dropped")
    one_side = atm_iv_by_expiry_from_rows(calls[:2], [], 226.0, today, truncated=False)
    check(len(one_side) == 1 and abs(one_side[0]["atm_iv_avg"] - 0.50) < 1e-12 and one_side[0]["atm_iv_put"] is None, "call-only expiry → avg of the one side, put null")
    check(atm_iv_by_expiry_from_rows([], [], 226.0, today, truncated=False) == [], "no rows → empty")
    print("cm_grouping ok")

    # DTE / expiry-window "today" is the ET calendar day, not the UTC day.
    # ET 20:30 → UTC already rolled to the next day; the old UTC anchor made
    # DTE one short. ET midday → both anchors agree (zero change).
    eve = datetime(2026, 10, 31, 0, 30, tzinfo=timezone.utc)  # = 2026-10-30 20:30 EDT
    check(et_today(eve) == datetime(2026, 10, 30).date(), "ET 20:30 (EDT) → ET today = 10-30, not UTC 10-31")
    eve_rows = [row("2026-11-06", 225.0, 0.50)]
    eve_dte = atm_iv_by_expiry_from_rows(eve_rows, [], 226.0, et_today(eve), truncated=False)[0]["dte"]
    check(eve_dte == 7, "ET 20:30: 10-30 → 11-06 Friday = 7 DTE on the ET calendar")
    eve_est = datetime(2026, 12, 4, 1, 30, tzinfo=timezone.utc)  # = 2026-12-03 20:30 EST
    check(et_today(eve_est) == datetime(2026, 12, 3).date(), "ET 20:30 (EST, after DST ends) → ET today = 12-03")
    noon = datetime(2026, 10, 30, 16, 0, tzinfo=timezone.utc)  # = 2026-10-30 12:00 EDT
    check(et_today(noon) == noon.date(), "ET 12:00 → ET today == UTC date (old and new agree)")
    noon_dte = atm_iv_by_expiry_from_rows(eve_rows, [], 226.0, et_today(noon), truncated=False)[0]["dte"]
    check(noon_dte == (datetime(2026, 11, 6).date() - noon.date()).days == 7, "ET 12:00: DTE identical under old (UTC) and new (ET) anchor")
    check(isinstance(et_today(), type(noon.date())), "et_today() with no arg returns a date")
    print("et_anchor ok")

    if failures:
        print(f"SELFTEST FAILED ({failures})")
        return 1
    print("SELFTEST PASSED")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument(
        "--target-dte",
        type=int,
        default=CM_TARGET_DTE_DEFAULT,
        help=f"constant-maturity target DTE alongside the fixed 30d (default {CM_TARGET_DTE_DEFAULT})",
    )
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.symbol:
        parser.error("--symbol is required (or use --selftest)")
    if args.target_dte < CM_DTE_FLOOR:
        parser.error(f"--target-dte must be ≥ {CM_DTE_FLOOR}")
    symbol = args.symbol.upper()

    try:
        # Pull ~1.5y of bars for HV + percentile rank
        bars = fetch_daily_bars(symbol, 504)  # ~2 years
        if len(bars) < 30:
            print(
                json.dumps({"error": "insufficient bars", "symbol": symbol}),
                file=sys.stderr,
            )
            return 3

        closes = [float(b["c"]) for b in bars]
        # 52-week high: max daily close over the last ~252 trading days (the
        # bars pull is ~504; slice to the trailing year). Display-only for the
        # market board "距高" column — distance of spot from this high.
        high_52w = max(closes[-252:]) if closes else None
        # Spot: use /v3/snapshot Universal so it matches get_chain / get_quote
        # (cross-session, pre/post-market aware). HV below is still from the
        # daily-close time series — that mismatch is intentional and documented.
        spot, spot_source = fetch_spot_universal(symbol)
        if spot is None:
            spot = closes[-1]
            spot_source = "daily_close_fallback"
        rets = log_returns(closes)

        hv20_series = rolling_hv(rets, 20)
        hv60_series = rolling_hv(rets, 60)
        hv252_series = rolling_hv(rets, 252)

        def latest(series):
            for v in reversed(series):
                if v is not None:
                    return v
            return None

        def history_clean(series):
            return [v for v in series if v is not None]

        hv20 = latest(hv20_series)
        hv60 = latest(hv60_series)
        hv252 = latest(hv252_series)

        hv20_history = history_clean(hv20_series)[-252:]
        hv20_percentile = (
            round(percentile_rank(hv20, hv20_history) * 100, 1)
            if hv20 is not None and hv20_history
            else None
        )

        # Concurrent ATM IV fetch (depends on spot already known)
        with ThreadPoolExecutor(max_workers=1) as ex:
            f_iv = ex.submit(fetch_front_month_atm_iv, symbol, spot)
            iv_block = f_iv.result()

        atm_iv = iv_block["atm_iv_avg"] if iv_block else None
        iv_hv_ratio = (
            atm_iv / hv20 if (atm_iv is not None and hv20 and hv20 > 0) else None
        )
        ratio_class = classify_iv_hv_ratio(iv_hv_ratio)

        # Ex-earnings HV (ORATS orHvXern idea) — rides ALONGSIDE the plain
        # fields; the three gate consumers (scanner / wheel-target / advisory
        # efficiency rule) keep reading the plain ratio until a human decides
        # to switch. Earnings fetch failure → nulls, plain fields unaffected.
        bar_dates = [
            datetime.fromtimestamp(b["t"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            for b in bars
        ]
        earn_dates = fetch_past_earnings_dates(
            symbol, bar_dates[0], datetime.now(timezone.utc).date().isoformat()
        )
        hv20_xern = hv60_xern = iv_hv_ratio_xern = None
        if earn_dates is not None:
            excl = earnings_exclusion_indices(bar_dates, earn_dates)
            hv20_xern = hv_excluding(rets, excl, 20)
            hv60_xern = hv_excluding(rets, excl, 60)
            iv_hv_ratio_xern = (
                atm_iv / hv20_xern
                if (atm_iv is not None and hv20_xern and hv20_xern > 0)
                else None
            )

        # Range-based estimators (Yang-Zhang OHLC + CBOE zero-mean) — ride
        # ALONGSIDE the plain fields exactly like xern; nothing above reads
        # them and no gate does. Take the LAST window (not `latest`): a hole
        # (bar missing o/h/l) must surface as null, not an older window.
        yz_obs = yz_observations(bars)

        def last(series):
            return series[-1] if series else None

        hv10_yz = last(rolling_yz_hv(yz_obs, 10))
        hv20_yz = last(rolling_yz_hv(yz_obs, 20))
        hv60_yz = last(rolling_yz_hv(yz_obs, 60))
        hv20_cc_zero = cc_zero_mean_hv(rets[-20:]) if len(rets) >= 20 else None
        hv20_yz_xern = (
            yz_hv_excluding(yz_obs, earnings_exclusion_indices(bar_dates, earn_dates), 20)
            if earn_dates is not None
            else None
        )
        iv_hv_ratio_yz = (
            atm_iv / hv20_yz if (atm_iv is not None and hv20_yz and hv20_yz > 0) else None
        )
        iv_hv_class_yz = classify_iv_hv_ratio(iv_hv_ratio_yz)

        # Constant-maturity ATM IV (CBOE bracket + total-variance interpolation)
        # — rides ALONGSIDE like xern/yz; its own try so a chain-snapshot
        # failure degrades to nulls + note and never touches the fields above.
        cm_target_dte = args.target_dte
        cm30 = cm_target = None
        cm_note = None
        cm_expiries = None
        try:
            cm_expiries = fetch_atm_iv_by_expiry(
                symbol, spot, CM_DTE_FLOOR, max(CM_DAYS_30, cm_target_dte) + CM_WINDOW_SLACK_DAYS
            )
            if cm_expiries is None:
                cm_note = "constant-maturity IV unavailable (chain snapshot fetch failed)"
            else:
                cm30 = bracket_constant_maturity(cm_expiries, CM_DAYS_30)
                cm_target = bracket_constant_maturity(cm_expiries, cm_target_dte)
                if cm30 is None:
                    cm_note = "constant-maturity IV unavailable (no expiry with ATM IV in the DTE window)"
        except Exception as exc:  # informational block: surface, don't fail the run
            cm_note = f"constant-maturity IV unavailable ({exc})"
        atm_iv_cm30 = cm30["value"] if cm30 else None
        iv_hv_ratio_cm30 = (
            atm_iv_cm30 / hv20 if (atm_iv_cm30 is not None and hv20 and hv20 > 0) else None
        )
        iv_hv_class_cm30 = classify_iv_hv_ratio(iv_hv_ratio_cm30)
        iv_hv_ratio_cm30_yz = (
            atm_iv_cm30 / hv20_yz if (atm_iv_cm30 is not None and hv20_yz and hv20_yz > 0) else None
        )
        if cm_note is None and cm30 is not None:
            cm_note = (
                "constant-maturity ATM IV: CBOE VIX bracket + total-variance interpolation "
                f"(30d {cm30['method']}"
                + (f"; {cm_target_dte}d {cm_target['method']}" if cm_target else "")
                + "); per-expiry ATM = same nearest-strike call+put average as atm_iv. "
                "Informational — gates and consumers still read atm_iv / iv_hv_ratio."
            )

        out = {
            "symbol": symbol,
            "as_of": datetime.now(timezone.utc).date().isoformat(),
            "spot": spot,
            "spot_source": spot_source,
            "high_52w": high_52w,
            "hv_20_annualized": hv20,
            "hv_20_percentile_rank": hv20_percentile,
            "hv_60_annualized": hv60,
            "hv_252_annualized": hv252,
            "atm_iv": atm_iv,
            "atm_iv_block": iv_block,
            "iv_hv_ratio": iv_hv_ratio,
            "ratio_class": ratio_class,
            "hv_20_xern": hv20_xern,
            "hv_60_xern": hv60_xern,
            "iv_hv_ratio_xern": iv_hv_ratio_xern,
            "xern_note": (
                "ex-earnings HV (earnings-day + next-day returns excluded; ORATS orHvXern idea) — informational, gates still read the plain ratio"
                if hv20_xern is not None
                else "ex-earnings HV unavailable (earnings calendar fetch failed or insufficient clean history)"
            ),
            "earnings_dates_excluded": len(earn_dates) if earn_dates is not None else None,
            "source": "polygon",
            # ── range-based estimators, side by side (BACKLOG hv-range-estimators) ──
            "hv_10_yz": hv10_yz,
            "hv_20_yz": hv20_yz,
            "hv_60_yz": hv60_yz,
            "hv_20_cc_zero_mean": hv20_cc_zero,
            "hv_20_yz_xern": hv20_yz_xern,
            "iv_hv_ratio_yz": iv_hv_ratio_yz,
            "iv_hv_label_yz": iv_hv_class_yz["label"],
            "iv_hv_class_yz": iv_hv_class_yz,
            "hv_estimator_note": (
                "plain = close-to-close sample stddev (mean-subtracted, n−1); "
                "yz = Yang-Zhang OHLC (overnight gap + open-to-close + Rogers-Satchell range, "
                "drift-independent, ~7x lower estimator variance); "
                "cc_zero_mean = CBOE RVOL convention (zero mean, /N). "
                "Informational — gates and consumers still read the plain ratio."
            ),
            # ── constant-maturity ATM IV, side by side (BACKLOG iv-constant-maturity-atm) ──
            "atm_iv_cm30": atm_iv_cm30,
            "atm_iv_cm_target": cm_target["value"] if cm_target else None,
            "atm_iv_cm_target_dte": cm_target_dte,
            "iv_hv_ratio_cm30": iv_hv_ratio_cm30,
            "iv_hv_label_cm30": iv_hv_class_cm30["label"],
            "iv_hv_class_cm30": iv_hv_class_cm30,
            "iv_hv_ratio_cm30_yz": iv_hv_ratio_cm30_yz,
            "iv_cm_bracket": {k: v for k, v in cm30.items() if k != "value"} if cm30 else None,
            "iv_cm_bracket_target": {k: v for k, v in cm_target.items() if k != "value"} if cm_target else None,
            "iv_cm_note": cm_note,
            "api_calls_polygon": _http_helper.request_count,
            # 按到期 ATM IV 阶梯(上面 CM 块已取到,零新增请求)— compute_implied_move 取目标到期
            # 自身 IV 用;窗口 DTE ∈ [1, max(30, --target-dte)+35],截断页的末组已丢;失败 → null
            "atm_iv_by_expiry": cm_expiries,
        }
        print(json.dumps(out))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc), "symbol": symbol}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
