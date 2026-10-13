from __future__ import annotations

import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.integrations import bingx
from bingx_fixtures import responses

WALLET = {"api_key": "test-key", "api_secret": "test-secret"}


class BingXTests(unittest.TestCase):
    def setUp(self):
        self.data = responses()
        self.calls = []
        self.pace = patch.object(bingx, "_pace")
        self.pace.start()
        self.addCleanup(self.pace.stop)
        bingx._price_cache = (0.0, {})
        bingx._clock_offset = (0.0, 0)

    def fetch(self):
        def get(client, path, params=None, *, signed=True):
            self.calls.append((path, params, signed))
            return self.data[path]
        with patch.object(bingx._Client, "get", get):
            return bingx.fetch_bingx_assets(WALLET)

    def test_signature_fixed_vector(self):
        query = bingx._signed_query("test-secret", {
            "timestamp": 1700000000000, "currency": "USDT", "recvWindow": 5000,
        })
        self.assertEqual(query, "currency=USDT&recvWindow=5000&timestamp=1700000000000&signature="
                         "b79a3af1f0d4fe51675408016babef7e3b871c05a9bd555a1d8c5cd69ee5db94")

    def test_spot_locked_and_futures_equity_without_positions(self):
        result = self.fetch()
        self.assertEqual(result["balance"], 250)
        self.assertEqual({a["chain"] for a in result["assets"]}, {"bingx-spot", "bingx-usdm"})
        self.assertNotIn("positions", result)
        self.assertEqual({call[0] for call in self.calls}, {
            bingx.SPOT_BALANCE, bingx.FUTURES_BALANCE, bingx.TICKERS,
        })
        self.assertEqual(sum(a["usd_value"] for a in result["assets"]), 250)

    def test_negative_pnl_already_in_equity(self):
        self.data["/openApi/swap/v3/user/balance"][0].update(equity="30", unrealizedProfit="-10")
        self.assertEqual(self.fetch()["balance"], 230)

    def test_explicit_zero_wallets(self):
        self.data["/openApi/spot/v1/account/balance"] = {"balances": []}
        self.data["/openApi/swap/v3/user/balance"] = [{"asset": "USDT", "equity": "0"}]
        self.assertEqual(self.fetch()["balance"], 0)
        self.assertFalse(any("ticker" in call[0] for call in self.calls))

    def test_missing_or_malformed_equity_never_becomes_zero(self):
        for value in (None, "bad", "NaN", "Infinity", "-1", True):
            with self.subTest(value=value):
                self.data["/openApi/swap/v3/user/balance"][0]["equity"] = value
                with self.assertRaises(bingx.BingXError):
                    self.fetch()

    def test_ambiguous_missing_usdt_wallet_fails(self):
        self.data["/openApi/swap/v3/user/balance"] = []
        with self.assertRaises(bingx.BingXError):
            self.fetch()

    def test_unpriced_spot_never_silently_disappears(self):
        self.data["/openApi/spot/v1/account/balance"]["balances"].append(
            {"asset": "UNLISTED", "free": "1", "locked": "0"})
        with self.assertRaisesRegex(bingx.BingXError, "UNLISTED"):
            self.fetch()


    def test_business_error_is_sanitized_and_not_retried(self):
        with patch.object(bingx, "_http_get", return_value={
            "code": 100413, "msg": "test-key test-secret signed-url", "data": []
        }) as request:
            with self.assertRaises(bingx.BingXError) as error:
                bingx._Client(**WALLET).get(bingx.FUTURES_BALANCE)
        self.assertEqual(request.call_count, 1)
        self.assertIn("100413", str(error.exception))
        self.assertNotIn("test-key", str(error.exception))
        self.assertNotIn("test-secret", str(error.exception))

    def test_timestamp_error_corrects_once_and_resigns(self):
        with patch.object(bingx, "_http_get", side_effect=[
            {"code": 100421}, {"code": 0, "data": {"serverTime": 1700000005000}},
            {"code": 0, "data": []},
        ]) as request, patch.object(bingx.time, "time", return_value=1700000000):
            self.assertEqual(bingx._Client(**WALLET).get(bingx.FUTURES_BALANCE), [])
        urls = [call.args[0] for call in request.call_args_list]
        self.assertIn("/openApi/swap/v2/server/time", urls[1])
        self.assertEqual(parse_qs(urlsplit(urls[2]).query)["timestamp"], ["1700000005000"])
        self.assertNotEqual(urls[0], urls[2])

    def test_http_rate_limit_no_immediate_retry_or_secret_leak(self):
        error = urllib.error.HTTPError("https://secret-url", 429, "secret-msg", {"Retry-After": "30"}, io.BytesIO())
        with patch.object(bingx, "_http_get", side_effect=error) as request:
            with self.assertRaises(bingx.BingXError) as caught:
                bingx._Client(**WALLET).get("/openApi/spot/v1/account/balance")
        self.assertEqual(request.call_count, 1)
        self.assertIn("30", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))

    def test_query_failure_and_missing_envelope_do_not_mean_empty(self):
        for payload in ({"code": 100413, "data": []}, {"data": []}, {"code": 0}, []):
            with self.subTest(payload=payload), patch.object(bingx, "_http_get", return_value=payload):
                with self.assertRaises(bingx.BingXError):
                    bingx._Client(**WALLET).get(bingx.FUTURES_BALANCE)

    def test_network_retry_is_bounded(self):
        with patch.object(bingx, "_http_get", side_effect=TimeoutError("secret-url")) as request, \
             patch.object(bingx.time, "sleep"):
            with self.assertRaises(bingx.BingXError) as caught:
                bingx._Client(**WALLET).get("/openApi/spot/v1/account/balance")
        self.assertEqual(request.call_count, 2)
        self.assertNotIn("secret", str(caught.exception))

    def test_public_price_cache_is_unsigned_and_reused(self):
        def request(url, headers):
            path = urlsplit(url).path
            if path == bingx.TICKERS:
                self.assertNotIn("X-BX-APIKEY", headers)
                self.assertNotIn("signature", url)
            else:
                self.assertEqual(headers["X-BX-APIKEY"], "test-key")
                self.assertIn("signature=", url)
            return {"code": 0, "data": self.data[path]}
        with patch.object(bingx, "_http_get", side_effect=request) as mocked:
            self.assertEqual(bingx.fetch_bingx_assets(WALLET)["balance"], 250)
            self.assertEqual(bingx.fetch_bingx_assets(WALLET)["balance"], 250)
        self.assertEqual(sum(bingx.TICKERS in c.args[0] for c in mocked.call_args_list), 1)

    def test_malformed_wallet_shapes_and_duplicate_rows_fail(self):
        for path, value in [(bingx.SPOT_BALANCE, {}), (bingx.FUTURES_BALANCE, {}),
                            (bingx.FUTURES_BALANCE, [{"asset": "USDT", "equity": "1"}] * 2)]:
            with self.subTest(path=path, value=value):
                self.data = responses()
                self.data[path] = value
                with self.assertRaises(bingx.BingXError):
                    self.fetch()

    def test_missing_credential_never_makes_request(self):
        with patch.object(bingx, "_http_get") as request:
            with self.assertRaises(bingx.BingXError):
                bingx.fetch_bingx_assets({"api_key": "test-key"})
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
