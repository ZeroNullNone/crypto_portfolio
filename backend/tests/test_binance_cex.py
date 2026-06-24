from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations import cex  # noqa: E402


def test_binance_wallet_summary_covers_non_spot_wallets() -> None:
    usdm_name = "USD\u24c8-M Futures"

    def fake_request_json_allow_statuses(url: str, **_: Any) -> Any:
        if url.endswith("/sapi/v1/asset/wallet/balance"):
            return [
                {"walletName": "Spot", "balance": "100"},
                {"walletName": "Funding", "balance": "12"},
                {"walletName": "Earn", "balance": "5"},
                {"walletName": usdm_name, "balance": "20"},
                {"walletName": "COIN-M Futures", "balance": "3"},
                {"walletName": "Copy Trading", "balance": "4"},
            ]
        if url.endswith("/api/v3/account"):
            return {"balances": [{"asset": "USDT", "free": "100", "locked": "0"}]}
        if url.endswith("/papi/v1/balance"):
            return None
        if url.endswith("/fapi/v2/account"):
            return {
                "totalMarginBalance": "20",
                "assets": [{"asset": "USDT", "walletBalance": "20", "availableBalance": "20"}],
            }
        if url.endswith("/dapi/v1/balance"):
            return [{"asset": "BTC", "balance": "0.001", "availableBalance": "0.001"}]
        raise AssertionError(url)

    def fake_request_json(url: str, **_: Any) -> Any:
        if url.endswith("/api/v3/ticker/price"):
            return [{"symbol": "BTCUSDT", "price": "3000"}]
        raise AssertionError(url)

    original_allow = cex._request_json_allow_statuses
    original_request = cex._request_json
    cex._request_json_allow_statuses = fake_request_json_allow_statuses
    cex._request_json = fake_request_json
    try:
        result = cex.fetch_binance_assets({"name": "stub", "api_key": "key", "api_secret": "secret"})
    finally:
        cex._request_json_allow_statuses = original_allow
        cex._request_json = original_request

    assert result["balance"] == 144.0
    symbols = {row["symbol"] for row in result["assets"]}
    assert {"USDT", "BTC", "FUNDING", "EARN", "COPY_TRADING"} <= symbols
    assert not {"SPOT", "USDM_FUTURES", "COINM_FUTURES"} & symbols


if __name__ == "__main__":
    test_binance_wallet_summary_covers_non_spot_wallets()
