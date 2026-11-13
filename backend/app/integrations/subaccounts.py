"""Opt-in, read-only master-key sync. Return ledger rows, never position notional."""
from __future__ import annotations

import math
from typing import Any

from . import bingx, cex


def rows(value: Any) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError("Incomplete exchange account details; previous snapshot retained.")
    return value


def number(value: Any) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError("Missing exchange balance.")
    n = float(value)
    if not math.isfinite(n):
        raise ValueError("Invalid exchange balance.")
    return n


def identifier(value: Any) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool) or not str(value).strip():
        raise ValueError("Missing exchange account or asset identifier.")
    return str(value).strip()


def unique(value: Any, seen: set[str]) -> str:
    key = identifier(value)
    if key in seen:
        raise ValueError("Exchange returned duplicate account details. Retry sync.")
    seen.add(key)
    return key


def estimate(member: str, chain: str, usd: float) -> dict:
    return {"member": member, "chain": chain, "symbol": "Valuation only", "valuation_only": True,
            "usd_value": usd, "amount": 0, "unit_price": 0}


def token(member: str, chain: str, symbol: str, amount: float, price: float) -> dict:
    return {"member": member, "chain": chain, "symbol": symbol, "amount": amount,
            "unit_price": price, "usd_value": amount * price}


def result(assets: list[dict]) -> dict:
    return {"balance": math.fsum(a["usd_value"] for a in assets), "assets": assets}


def reconcile(member: str, exchange: str, total: float, assets: list[dict]) -> list[dict]:
    """Retain unitemized equity without attributing it to a token."""
    residual = number(total) - math.fsum(a["usd_value"] for a in assets)
    if abs(residual) > 1e-8:
        assets.append(estimate(member, exchange + "-valuation-adjustment", residual))
    return assets


def fetch_bingx(wallet: dict) -> dict:
    client = bingx._Client(wallet["api_key"], wallet["api_secret"])
    assets = []
    main_overview = client.get("/openApi/account/v1/allAccountBalance")
    wallets = rows(main_overview["result"] if isinstance(main_overview, dict) else main_overview)

    def add_wallets(member: str, items: list[dict], uid: str | None):
        seen: set[str] = set()
        for item in items:
            bucket = unique(identifier(item.get("accountType")).lower().replace("sopt", "spot"), seen)
            value = number(item.get("usdtBalance"))
            if not value:
                continue
            if bucket == "spot":
                detail = (client.get("/openApi/subAccount/v1/assets", {"subUid": uid})
                          if uid else client.get(bingx.SPOT_BALANCE))
                coins = bingx._spot_assets(client, rows(detail["balances"]))
            elif not uid and bucket == "usdtmperp" and value > 0:
                coins = bingx._usdt_perpetual_assets(client)
            else:
                coins = []
            if coins:
                assets.extend(dict(a, member=member) for a in coins)
                continue
            chain = {"usdtmperp": "usdm", "coinmperp": "coinm", "eran": "earn"}.get(bucket, bucket)
            assets.append(estimate(member, "bingx-" + chain, value))

    add_wallets("Main account", wallets, None)
    seen: set[str] = set()
    expected = None
    for page in range(1, 1001):
        data = client.get("/openApi/subAccount/v1/allAccountBalance", {"pageIndex": page, "pageSize": 10})
        total = int(identifier(data["total"]))
        if total < 0 or (expected is not None and total != expected):
            raise ValueError("BingX subaccount list changed. Retry sync.")
        expected = total
        batch = rows(data["result"])
        for sub in batch:
            uid = unique(sub.get("subUid"), seen)
            add_wallets("Subaccount " + uid, rows(sub["accountBalances"]), uid)
        if len(seen) == total:
            return result(assets)
        if not batch or len(seen) > total:
            break
    raise ValueError("Incomplete BingX subaccount list. Retry sync.")


def fetch_bybit(wallet: dict) -> dict:
    creds = cex._load_cex_credentials(wallet)
    overview, _ = cex._bybit_request(creds, "/v5/asset/total-members-assets", params={"coin": "USDT"})
    members = rows(overview["list"])
    if number(overview["stat"]) != 0 or sum(m.get("isM") is True for m in members) != 1:
        raise ValueError("Bybit did not return a complete master account overview.")
    assets = []
    seen: set[str] = set()
    for m in members:
        uid = unique(m.get("uid"), seen)
        if str(m.get("type", "")) == "8":  # Bybit demo subaccount
            continue
        if number(m["stat"]) != 0 or any(number(item["stat"]) != 0 for item in rows(m.get("items", []))):
            raise ValueError("Incomplete Bybit member overview. Retry sync.")
        is_master = m.get("isM") is True
        member = "Main account" if is_master else "Subaccount " + uid
        if is_master:
            main = cex.fetch_bybit_assets(wallet)
            main_rows = [dict(a, member=member) for a in main["assets"]]
            assets.extend(reconcile(member, "bybit", main["balance"], main_rows))
            continue
        params = {"valuationCurrency": "USD", "memberId": uid}
        detail, _ = cex._bybit_request(creds, "/v5/asset/asset-overview", params=params)
        total = number(detail["totalEquity"])
        buckets = []
        for account in rows(detail["list"]):
            label = identifier(account["accountType"])
            cats = rows(account.get("categories") or [])
            if cats:
                for cat in cats:
                    buckets.append((cex._bybit_chain(label, identifier(cat["category"])),
                                    number(cat["equity"]), rows(cat.get("coinDetail") or [])))
            else:
                buckets.append((cex._bybit_chain(label), number(account["totalEquity"]),
                                rows(account.get("coinDetail") or [])))
        # Alpha farms can return values in USD instead of units of the named coin.
        def token_units(c):
            unit = (c.get("extMap") or {}).get("equityUnit")
            return not unit or str(unit).upper() == identifier(c["coin"]).upper()

        symbols = [identifier(c["coin"]).upper() for _, _, coins in buckets if len(coins) > 1
                   for c in coins if token_units(c)]
        prices = cex._asset_unit_prices(symbols)
        member_rows = []
        for chain, equity, coins in buckets:
            if any(not token_units(c) for c in coins):
                if equity:
                    member_rows.append(estimate(member, chain, equity))
                continue
            entries = [(identifier(c["coin"]).upper(), number(c["equity"])) for c in coins]
            entries = [(s, n) for s, n in entries if n]
            # A single underlying quantity can use the exchange's own USD valuation.
            if len(entries) == 1 and equity / entries[0][1] > 0:
                s, n = entries[0]
                member_rows.append(token(member, chain, s, n, equity / n))
            elif entries and all(prices.get(s, 0) > 0 for s, _ in entries):
                member_rows.extend(token(member, chain, s, n, prices[s]) for s, n in entries)
            elif equity:
                member_rows.append(estimate(member, chain, equity))
        # Product-only valuations, different price sources and liabilities must
        # reconcile to this member's authoritative equity, never the family total twice.
        assets.extend(reconcile(member, "bybit", total, member_rows))
    return result(assets)


def fetch_binance(wallet: dict) -> dict:
    main = cex.fetch_binance_assets(wallet)
    creds = cex._load_cex_credentials(wallet)

    def get(path: str, **params):
        signed = cex._binance_signed_params(creds["api_secret"], {**params, "timestamp": cex._now_ms()})
        try:
            return cex._request_json("https://api.binance.com" + path,
                                     headers=cex._binance_headers(creds["api_key"]), params=signed)
        except OSError:
            raise RuntimeError(f"Binance {path} failed; check master-key access and retry.") from None

    # This endpoint returns ALL subaccounts when email is omitted, including
    # their enabled wallet types. Never request disabled derivative accounts.
    statuses = rows(get("/sapi/v1/sub-account/status"))
    quantities = []
    seen: set[str] = set()
    for status in statuses:
        email = unique(status.get("email"), seen)
        member = "Subaccount " + email
        for flag in ("isMarginEnabled", "isFutureEnabled"):
            if not isinstance(status.get(flag), bool):
                raise ValueError("Missing Binance subaccount wallet status.")
        spot = get("/sapi/v4/sub-account/assets", email=email)
        for c in rows(spot["balances"]):
            n = number(c["free"]) + number(c["locked"]) + number(c.get("freeze", 0)) + number(c.get("withdrawing", 0))
            if n:
                quantities.append((member, "binance-spot", identifier(c["asset"]).upper(), n))
        if status["isMarginEnabled"]:
            margin = get("/sapi/v1/sub-account/margin/account", email=email)
            for c in rows(margin["marginUserAssetVoList"]):
                n = number(c["netAsset"])
                if n:
                    quantities.append((member, "binance-cross-margin", identifier(c["asset"]).upper(), n))
        if status["isFutureEnabled"]:
            for mode, bucket, field in [(1, "usdm", "futureAccountResp"), (2, "coinm", "deliveryAccountResp")]:
                response = get("/sapi/v2/sub-account/futures/account", email=email, futuresType=mode)
                detail = response.get(field, response)
                for c in rows(detail["assets"]):
                    n = number(c["marginBalance"])
                    if n:
                        quantities.append((member, "binance-" + bucket, identifier(c["asset"]).upper(), n))
    prices = cex._asset_unit_prices([s for _, _, s, _ in quantities])
    extra = []
    for member, chain, symbol, amount in quantities:
        price = prices.get(symbol, 0)
        if not math.isfinite(price) or price <= 0:
            raise ValueError(f"Missing Binance price for {symbol}; previous balance retained.")
        extra.append(token(member, chain, symbol, amount, price))
    main_rows = [dict(a, member="Main account") for a in main["assets"]]
    return result(reconcile("Main account", "binance", main["balance"], main_rows) + extra)
