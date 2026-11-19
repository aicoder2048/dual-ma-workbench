"""Shared Polygon / Finnhub HTTP access for theta Python tool sidecars.

Loads <app>/.env on import, so a script only needs:

    from _http_helper import polygon_get

Every helper keeps the contract the per-script copies had: 200 → parsed JSON,
429 → exponential backoff (4s, 8s, 16s) up to MAX_RETRIES, any other status →
None (or HttpStatusError when the caller passes strict=True). A missing API key raises RuntimeError with the caller's message.
"""

import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

POLYGON_BASE = "https://api.polygon.io"
FINNHUB_BASE = "https://finnhub.io/api/v1"
MAX_RETRIES = 3
BACKOFF_BASE = 2
POLYGON_KEY_MISSING = "POLYGON_API_KEY not set"
POLYGON_KEY_MISSING_LONG = "POLYGON_API_KEY not set (looked in env and LearnOptions/.env)"

# HTTP requests issued through polygon_get / finnhub_get in this process (each
# attempt counts, 429 retries included). get_volatility reports it as
# api_calls_polygon; it never calls finnhub_get.
request_count = 0


class HttpStatusError(RuntimeError):
    """strict 模式下的非 200 失败(含 429 重试耗尽);带 HTTP 状态,读取方可区分「取数失败」与「真没数据」。"""

    def __init__(self, status: int, url: str, body: str):
        self.status = status
        super().__init__(f"HTTP {status} from {url}: {body[:200]}")


def _get_json(url: str, params: dict, timeout: float, strict: bool = False) -> dict | None:
    global request_count
    resp = None
    for attempt in range(MAX_RETRIES):
        request_count += 1
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            time.sleep(BACKOFF_BASE ** (attempt + 2))
            continue
        break
    if strict and resp is not None:
        raise HttpStatusError(resp.status_code, url, resp.text or "")
    return None


def polygon_key(missing_msg: str = POLYGON_KEY_MISSING) -> str:
    api_key = os.environ.get("POLYGON_API_KEY")
    if not api_key:
        raise RuntimeError(missing_msg)
    return api_key


def polygon_get(
    path: str,
    params: dict | None = None,
    *,
    timeout: float = 15,
    missing_key_msg: str = POLYGON_KEY_MISSING,
    strict: bool = False,
) -> dict | None:
    """strict=True:非 200(含 429 耗尽)抛 HttpStatusError,而不是 return None。"""
    params = dict(params or {})
    params["apiKey"] = polygon_key(missing_key_msg)
    return _get_json(f"{POLYGON_BASE}{path}", params, timeout, strict)


def finnhub_get(path: str, params: dict | None = None, *, strict: bool = False) -> dict | None:
    """strict=True:非 200(含 429 耗尽)抛 HttpStatusError,而不是 return None。"""
    api_key = os.environ.get("FINNHUB_API_KEY")
    if not api_key:
        raise RuntimeError("FINNHUB_API_KEY not set")
    params = dict(params or {})
    params["token"] = api_key
    return _get_json(f"{FINNHUB_BASE}{path}", params, timeout=15, strict=strict)


def list_option_expirations(symbol: str, contract_type: str) -> list[str]:
    """Sorted unexpired expirations from /v3/reference/options/contracts.

    High-strike-count names like TSLA can exceed Polygon's 1,000-row page before
    later expirations (e.g. a monthly) appear, so this follows next_url. Polygon's
    next_url does not always carry apiKey, so it is re-sent on every page. A
    non-200 page ends the walk with what was collected so far.
    """
    api_key = polygon_key(POLYGON_KEY_MISSING_LONG)
    params = {
        "underlying_ticker": symbol,
        "contract_type": contract_type,
        "expired": "false",
        "limit": 1000,
        "order": "asc",
        "sort": "expiration_date",
        "apiKey": api_key,
    }
    url = f"{POLYGON_BASE}/v3/reference/options/contracts"
    expirations: set[str] = set()
    for _ in range(20):  # hard safety cap; 20k contracts is plenty for one ticker side
        resp = requests.get(url, params=params, timeout=15)
        if resp.status_code != 200:
            break
        data = resp.json()
        for r in data.get("results") or []:
            if r.get("expiration_date"):
                expirations.add(r["expiration_date"])
        next_url = data.get("next_url")
        if not next_url:
            break
        url = next_url
        params = {"apiKey": api_key}
    return sorted(expirations)
