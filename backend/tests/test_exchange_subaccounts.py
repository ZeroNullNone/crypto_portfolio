import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.integrations import bingx, cex
from bingx_fixtures import responses

WALLET = {"name": "fixture", "api_key": "fixture", "api_secret": "test", "include_subaccounts": True}


class SubaccountTests(unittest.TestCase):
    def test_bingx_empty_master_with_funded_subaccounts_needs_no_master_futures_wallet(self):
        data = responses()
        data["/openApi/account/v1/allAccountBalance"]["result"] = []
        del data[bingx.FUTURES_BALANCE], data[bingx.SPOT_BALANCE]
        with patch.object(bingx._Client, "get", lambda _, path, *args: data[path]):
            family = cex.fetch_cex_assets(dict(WALLET, exchange="bingx"))
        self.assertEqual(family["balance"], 100)
        self.assertTrue(all(a["member"].startswith("Subaccount ") for a in family["assets"]))

    def test_bingx_pages_are_complete_before_the_result_is_accepted(self):
        data = responses()
        path = "/openApi/subAccount/v1/allAccountBalance"
        first, second = data[path]["result"]
        def run(last):
            def get(client, endpoint, params=None, **kwargs):
                if endpoint == path:
                    return {"total": 2, "result": [first] if params["pageIndex"] == 1 else last}
                return data[endpoint]
            with patch.object(bingx._Client, "get", get):
                return cex.fetch_cex_assets(dict(WALLET, exchange="bingx"))
        self.assertEqual(run([second])["balance"], 350)
        for last in ([], [first]):
            with self.assertRaises(ValueError):
                run(last)

    def test_bybit_fetches_each_uid_once_and_keeps_aggregate_estimates_out_of_coins(self):
        overview = {"stat": 0, "list": [{"uid": 1, "stat": 0, "isM": True}, {"uid": 2, "stat": 0},
                                        {"uid": 3, "type": 8, "stat": 0}]}
        def request(creds, path, *, params):
            if path.endswith("total-members-assets"):
                return overview, None
            self.assertEqual(params["memberId"], "2")
            return {"totalEquity": 25, "list": [
                {"accountType": "FundingAccount", "totalEquity": 10, "coinDetail": [{"coin": "USDT", "equity": 10}]},
                {"accountType": "Alpha", "categories": [{"category": "farm", "equity": 15,
                    "coinDetail": [{"coin": "BTC", "equity": 15, "extMap": {"equityUnit": "USD"}}]}]}]}, None
        with patch.object(cex, "_bybit_request", side_effect=request), patch.object(
                cex, "fetch_bybit_assets", return_value={"balance": 8, "assets": [
                    {"symbol": "USDT", "usd_value": 8, "amount": 8}]}):
            family = cex.fetch_cex_assets(dict(WALLET, exchange="bybit"))
            self.assertEqual(family["balance"], 33)
            self.assertEqual(sum(a["amount"] for a in family["assets"] if a["symbol"] == "USDT"), 18)
            self.assertEqual([a["usd_value"] for a in family["assets"] if a.get("valuation_only")], [15])
            overview["list"][1]["stat"] = 1
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                cex.fetch_cex_assets(dict(WALLET, exchange="bybit"))

    def test_binance_net_wallet_balances_not_futures_notional_or_margin_debt_twice(self):
        status = [{"email": "sub@example.test", "isFutureEnabled": True, "isMarginEnabled": True}]
        def request(url, *, headers, params):
            self.assertIn("signature", params)
            if url.endswith("/status"):
                return status
            self.assertEqual(params["email"], "sub@example.test")
            if url.endswith("/assets"):
                return {"balances": [{"asset": "USDT", "free": 10, "locked": 5, "freeze": 1, "withdrawing": 2}]}
            if url.endswith("/margin/account"):
                return {"marginUserAssetVoList": [{"asset": "USDT", "netAsset": -3}]}
            a = {"asset": "USDT", "marginBalance": 7, "walletBalance": 5}
            if params["futuresType"] == 1:
                return {"futureAccountResp": {"assets": [a]}}
            return {"deliveryAccountResp": {"assets": [{"asset": "BTC", "marginBalance": 0.01}]}}
        with patch.object(cex, "_request_json", side_effect=request), patch.object(
                cex, "_asset_unit_prices", return_value={"USDT": 1, "BTC": 1000}), patch.object(
                cex, "fetch_binance_assets", return_value={"balance": 100, "assets": []}):
            family = cex.fetch_cex_assets(dict(WALLET, exchange="binance"))
            self.assertEqual(family["balance"], 132)
            self.assertEqual(len(family["assets"]), 5)
            self.assertEqual([a["usd_value"] for a in family["assets"] if a.get("valuation_only")], [100])
            del status[0]["isMarginEnabled"]
            with self.assertRaisesRegex(ValueError, "wallet status"):
                cex.fetch_cex_assets(dict(WALLET, exchange="binance"))
