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
        if url.endswith("/sapi/v1/asset/get-funding-asset"):
            return [{"asset": "USDT", "free": "12", "locked": "0", "freeze": "0"}]
        if url.endswith("/sapi/v1/simple-earn/flexible/position"):
            return {"rows": [{"asset": "USDT", "totalAmount": "5"}], "total": 1}
        if url.endswith("/sapi/v1/simple-earn/locked/position"):
            return {"rows": [], "total": 0}
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
    chains = {row["chain"] for row in result["assets"]}
    assert {"USDT", "BTC", "COPY_TRADING"} <= symbols
    assert {"binance-funding", "binance-earn-flexible"} <= chains
    assert not {"SPOT", "USDM_FUTURES", "COINM_FUTURES", "FUNDING", "EARN"} & symbols


def test_bybit_asset_overview_covers_all_account_categories() -> None:
    def fake_request_json(url: str, **_: Any) -> Any:
        if url.endswith("/v5/account/wallet-balance"):
            return {
                "retCode": 0,
                "retMsg": "OK",
                "result": {
                    "list": [
                        {
                            "totalEquity": "100",
                            "coin": [
                                {
                                    "coin": "USDT",
                                    "equity": "100",
                                    "walletBalance": "100",
                                    "usdValue": "100",
                                    "locked": "0",
                                }
                            ],
                        }
                    ]
                },
            }
        if url.endswith("/v5/asset/asset-overview"):
            return {
                "retCode": 0,
                "retMsg": "Success",
                "result": {
                    "totalEquity": "130",
                    "list": [
                        {"accountType": "UnifiedTradingAccount", "totalEquity": "100"},
                        {
                            "accountType": "FundingAccount",
                            "totalEquity": "12",
                            "coinDetail": [{"coin": "USDT", "equity": "12"}],
                        },
                        {
                            "accountType": "Earn",
                            "categories": [
                                {
                                    "category": "Easy Earn",
                                    "equity": "5",
                                    "coinDetail": [{"coin": "USDT", "equity": "5"}],
                                }
                            ],
                        },
                        {
                            "accountType": "TradingBot",
                            "categories": [
                                {
                                    "category": "Futures Grid Bot",
                                    "equity": "7",
                                    "coinDetail": [{"coin": "USDT", "equity": "7"}],
                                }
                            ],
                        },
                        {
                            "accountType": "CopyTrading",
                            "categories": [
                                {
                                    "category": "Copy Trading Pro",
                                    "equity": "6",
                                    "coinDetail": [{"coin": "USDT", "equity": "6"}],
                                }
                            ],
                        },
                    ],
                },
            }
        raise AssertionError(url)

    original_request = cex._request_json
    cex._request_json = fake_request_json
    try:
        result = cex.fetch_bybit_assets({"name": "stub", "api_key": "key", "api_secret": "secret"})
    finally:
        cex._request_json = original_request

    assert result["balance"] == 130.0
    symbols = {row["symbol"] for row in result["assets"]}
    chains = {row["chain"] for row in result["assets"]}
    assert symbols == {"USDT"}
    assert {
        "bybit-fundingaccount",
        "bybit-earn-easy-earn",
        "bybit-tradingbot-futures-grid-bot",
        "bybit-copytrading-copy-trading-pro",
    } <= chains
    assert "BYBIT_UNIFIEDTRADINGACCOUNT" not in symbols


if __name__ == "__main__":
    test_binance_wallet_summary_covers_non_spot_wallets()
    test_bybit_asset_overview_covers_all_account_categories()
