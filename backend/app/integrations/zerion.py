"""Zerion API client — EVM wallet balances + DeFi positions."""
from __future__ import annotations

import base64
import json
import urllib.parse
import urllib.request
from typing import Any

POSITIONS_URL = "https://api.zerion.io/v1/wallets/{address}/positions/"
CHAINS_URL = "https://api.zerion.io/v1/chains/"


def _auth_header(api_key: str) -> str:
    token = base64.b64encode(f"{api_key}:".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _fetch_json(url: str, api_key: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "accept": "application/json",
            "Authorization": _auth_header(api_key),
            "User-Agent": "crypto-portfolio-tracker/1.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Expected an object from Zerion")
    return data


def fetch_wallet_positions(
    address: str,
    api_key: str,
    timeout: float = 30.0,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    if not address:
        raise ValueError("Zerion wallet address is required.")
    if not api_key:
        raise ValueError("Zerion API key is required.")

    query = urllib.parse.urlencode({
        "page[size]": page_size,
        "filter[positions]": "no_filter",
        "filter[trash]": "only_non_trash",
        "currency": "usd",
        "sort": "-value",
    })
    url: str | None = f"{POSITIONS_URL.format(address=urllib.parse.quote(address))}?{query}"
    out: list[dict[str, Any]] = []
    while url:
        payload = _fetch_json(url, api_key, timeout)
        rows = payload.get("data") or []
        if not isinstance(rows, list):
            raise ValueError("Expected a list of positions from Zerion")
        out.extend(row for row in rows if isinstance(row, dict))
        links = payload.get("links") or {}
        url = str(links.get("next") or "") or None
    return out


def fetch_chains(api_key: str, timeout: float = 30.0) -> list[dict[str, Any]]:
    if not api_key:
        raise ValueError("Zerion API key is required.")

    url: str | None = CHAINS_URL
    out: list[dict[str, Any]] = []
    while url:
        payload = _fetch_json(url, api_key, timeout)
        rows = payload.get("data") or []
        if not isinstance(rows, list):
            raise ValueError("Expected a list of chains from Zerion")
        out.extend(row for row in rows if isinstance(row, dict))
        links = payload.get("links") or {}
        url = str(links.get("next") or "") or None
    return out
