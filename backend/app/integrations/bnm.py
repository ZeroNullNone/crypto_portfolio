"""Bank Negara Malaysia public FX helpers."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

USD_INTERBANK_INTRADAY_RATE_URL = "https://api.bnm.gov.my/public/usd-interbank-intraday-rate"
BNM_ACCEPT = "application/vnd.BNM.API.v1+json"


class BnmRateUnavailable(Exception):
    """Raised when BNM does not return a usable USD/MYR rate."""


def _lowest_usd_myr_from_payload(payload: Any) -> float:
    data = payload.get("data") if isinstance(payload, dict) else None
    value = data.get("lowest_rate") if isinstance(data, dict) else None
    try:
        rate = float(value)
    except (TypeError, ValueError) as exc:
        raise BnmRateUnavailable("bad BNM USD/MYR rate payload") from exc
    if rate <= 0:
        raise BnmRateUnavailable("non-positive BNM USD/MYR rate")
    return rate


def fetch_lowest_usd_myr_rate(*, timeout: float = 4.0) -> float:
    request = urllib.request.Request(
        USD_INTERBANK_INTRADAY_RATE_URL,
        headers={"Accept": BNM_ACCEPT},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise BnmRateUnavailable(f"BNM USD/MYR lookup failed ({exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise BnmRateUnavailable(f"BNM USD/MYR lookup failed: {exc}") from exc
    return _lowest_usd_myr_from_payload(payload)
