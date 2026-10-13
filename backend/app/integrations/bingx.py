"""Read-only BingX Spot + USDT perpetual portfolio adapter.

Contracts and sources: docs/bingx-api-research.md. Both supported wallets must
succeed before the caller may persist a new snapshot. Positions are not fetched.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation
from typing import Any

BASE_URL = "https://open-api.bingx.com"
SPOT_BALANCE = "/openApi/spot/v1/account/balance"
FUTURES_BALANCE = "/openApi/swap/v3/user/balance"
TICKERS = "/openApi/spot/v2/quote/ticker"
SERVER_TIME = "/openApi/swap/v2/server/time"

_lock = threading.Lock()
_price_lock = threading.Lock()
_next_request: dict[tuple[str, str], float] = {}
_price_cache: tuple[float, dict[str, Decimal]] = (0.0, {})
_clock_offset: tuple[float, int] = (0.0, 0)


class BingXError(RuntimeError):
    """Safe to expose in sync/credential errors; never includes provider text."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an API key or signed query to a redirected host.
        return None


def _http_get(url: str, headers: dict[str, str]) -> Any:
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"), parse_float=Decimal)


def _signed_query(secret: str, params: dict[str, Any]) -> str:
    pairs = [(key, str(value)) for key, value in sorted(params.items())
             if value is not None and key != "signature"]
    raw = "&".join(f"{key}={value}" for key, value in pairs)
    signature = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    query = "&".join(f"{key}={urllib.parse.quote(value, safe='')}" for key, value in pairs)
    return f"{query}&signature={signature}"


def _pace(scope: str, path: str) -> None:
    """Conservative per-process pacing, shared by validation/manual/worker calls.

    This is not a distributed UID limiter. Multiple keys/workers may share an
    exchange UID/IP, so provider throttling is also handled without retry storms.
    """
    now = time.monotonic()
    with _lock:
        if len(_next_request) > 1024:
            for key in [k for k, expiry in _next_request.items() if expiry < now]:
                del _next_request[key]
        ready = _next_request.get((scope, path), now)
        delay = max(0.0, ready - now)
        if delay > 2:
            raise BingXError(f"BingX requests are cooling down; retry in {int(delay) + 1}s.")
        _next_request[(scope, path)] = max(now, ready) + 1.0
    if delay:
        time.sleep(delay)


def _cooldown(scope: str, path: str, seconds: int) -> None:
    with _lock:
        _next_request[(scope, path)] = time.monotonic() + seconds


def _number(value: Any, label: str, *, nonnegative: bool = False) -> Decimal:
    try:
        if value is None or isinstance(value, bool):
            raise ValueError
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > Decimal("1e100"):
            raise ValueError
        if nonnegative and number < 0:
            raise ValueError
        return number
    except (InvalidOperation, ValueError, TypeError):
        raise BingXError(f"BingX returned invalid or unsupported {label}.") from None


def _rows(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise BingXError(f"BingX returned invalid {label} data.")
    return value


def _symbol(value: Any) -> str:
    # This also keeps provider-controlled names out of arbitrary error content.
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value):
        raise BingXError("BingX returned an invalid asset or instrument symbol.")
    return value.upper()


class _Client:
    def __init__(self, api_key: str, api_secret: str):
        if not api_key or not api_secret:
            raise BingXError("BingX requires an API key and API secret with Read permission.")
        self.api_key = api_key
        self.api_secret = api_secret
        self.scope = hashlib.sha256(api_key.encode()).hexdigest()
        self.offset_ms = _clock_offset[1] if time.monotonic() - _clock_offset[0] < 300 else 0

    def get(self, path: str, params: dict[str, Any] | None = None, *, signed: bool = True) -> Any:
        global _clock_offset
        for attempt in range(2):
            scope = self.scope if signed else "public"
            _pace(scope, path)
            query_params = dict(params or {})
            headers = {"Accept": "application/json"}
            if signed:
                query_params.update(timestamp=int(time.time() * 1000) + self.offset_ms, recvWindow=5000)
                query = _signed_query(self.api_secret, query_params)
                headers["X-BX-APIKEY"] = self.api_key
            else:
                query = urllib.parse.urlencode(query_params)
            url = f"{BASE_URL}{path}" + (f"?{query}" if query else "")
            try:
                payload = _http_get(url, headers)
            except urllib.error.HTTPError as exc:
                status = exc.code
                response_headers = exc.headers or {}
                exc.close()
                if status in (418, 429):
                    raw_delay = response_headers.get("Retry-After", "300")
                    delay = int(raw_delay) if str(raw_delay).isdigit() else 300
                    delay = max(1, min(delay, 86400))
                    _cooldown(scope, path, delay)
                    raise BingXError(f"BingX rate limit (HTTP {status}); retry after {delay}s.") from None
                if status >= 500 and attempt == 0:
                    time.sleep(0.25)
                    continue
                raise BingXError(f"BingX {path} failed (HTTP {status}); check Read access and IP restrictions.") from None
            except (TimeoutError, OSError):
                if attempt == 0:
                    time.sleep(0.25)
                    continue
                raise BingXError(f"BingX {path} is unreachable or timed out; retry later.") from None
            except (ValueError, UnicodeError):
                raise BingXError(f"BingX {path} returned an invalid JSON response.") from None

            if not isinstance(payload, dict) or "code" not in payload:
                raise BingXError(f"BingX {path} returned an invalid response envelope.")
            code = str(payload["code"])
            if code == "0":
                if "data" not in payload:
                    raise BingXError(f"BingX {path} returned no data field.")
                return payload["data"]
            if code == "100421" and signed and attempt == 0:
                clock = self.get(SERVER_TIME, signed=False)
                if not isinstance(clock, dict):
                    raise BingXError("BingX returned invalid server time.")
                server_ms = int(_number(clock.get("serverTime"), "server time", nonnegative=True))
                offset = server_ms - int(time.time() * 1000)
                if abs(offset) > 86400000:
                    raise BingXError("BingX clock differs by more than a day; check the server clock.")
                self.offset_ms = offset
                _clock_offset = (time.monotonic(), offset)
                continue
            if code == "100500" and attempt == 0:
                time.sleep(0.25)
                continue
            if code == "100410":
                _cooldown(scope, path, 300)
            reason = {
                "100001": "invalid signature; check the API secret",
                "100412": "signature required",
                "100413": "invalid API key or missing Read permission",
                "100419": "server IP is not allowed by the API key",
                "100421": "timestamp rejected; check the server clock",
                "100410": "rate limited; retry after 300s",
                "100500": "service busy; retry later",
            }.get(code, "request rejected; check Read permission and account availability")
            safe_code = code if re.fullmatch(r"\d{1,12}", code) else "unknown"
            raise BingXError(f"BingX {path}: {reason} (code {safe_code}).")
        raise BingXError("BingX request failed after a bounded retry.")


def _prices(client: _Client) -> dict[str, Decimal]:
    global _price_cache
    with _price_lock:
        if time.monotonic() - _price_cache[0] < 30:
            return _price_cache[1]
        rows = _rows(client.get(TICKERS, signed=False), "Spot tickers")
        prices = {}
        for row in rows:
            symbol = row.get("symbol")
            if not isinstance(symbol, str) or not symbol.endswith("-USDT"):
                continue
            try:
                price = _number(row.get("lastPrice"), "Spot price", nonnegative=True)
            except BingXError:
                continue  # A held asset with no usable quote fails below.
            if price > 0:
                prices[symbol[:-5].upper()] = price
        _price_cache = (time.monotonic(), prices)
        return prices


def _asset(symbol: str, amount: Decimal, price: Decimal, chain: str,
           available: Decimal, locked: Decimal) -> dict[str, Any]:
    return {"name": symbol, "symbol": symbol, "chain": chain,
            "amount": float(amount), "available": float(available), "locked": float(locked),
            "unit_price": float(price), "usd_value": float(amount * price)}


def fetch_bingx_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    client = _Client(str(wallet.get("api_key") or "").strip(), str(wallet.get("api_secret") or "").strip())
    spot = client.get(SPOT_BALANCE)
    if not isinstance(spot, dict):
        raise BingXError("BingX returned invalid Spot balances.")
    spot_rows = _rows(spot.get("balances"), "Spot balances")
    balances = _rows(client.get(FUTURES_BALANCE), "perpetual balances")
    usdt = [row for row in balances if row.get("asset") == "USDT"]
    if len(usdt) != 1:
        raise BingXError("BingX did not return one USDT perpetual balance; check account activation and Read permission.")
    equity = _number(usdt[0].get("equity"), "USDT perpetual equity (negative equity is unsupported)", nonnegative=True)

    quantities = {}
    for row in spot_rows:
        symbol = _symbol(row.get("asset"))
        if symbol == "VST":
            continue
        if symbol in quantities:
            raise BingXError("BingX returned duplicate Spot assets.")
        free = _number(row.get("free"), "Spot free amount", nonnegative=True)
        locked = _number(row.get("locked"), "Spot locked amount", nonnegative=True)
        quantities[symbol] = (free, locked)
    needs_prices = any(sym != "USDT" and free + locked > 0 for sym, (free, locked) in quantities.items())
    prices = {**(_prices(client) if needs_prices else {}), "USDT": Decimal(1)}
    total = equity
    assets = []
    for symbol, (free, locked) in quantities.items():
        amount = free + locked
        if amount == 0:
            continue
        price = prices.get(symbol)
        if price is None:
            raise BingXError(f"BingX cannot price Spot asset {symbol}: no valid {symbol}-USDT quote.")
        total += amount * price
        assets.append(_asset(symbol, amount, price, "bingx-spot", free, locked))
    if equity:
        # This is equity, not withdrawable cash. Do not fabricate margin availability.
        assets.append(_asset("USDT", equity, Decimal(1), "bingx-usdm", Decimal(0), Decimal(0)))

    return {"balance": float(total), "assets": assets,
            "fetch_strategy": "bingx Spot + USDT perpetual equity; USDT valued at USD 1"}
