"""Synthetic BingX responses shared by regression tests and the local UI harness."""
from copy import deepcopy

RESPONSES = {
    "/openApi/spot/v1/account/balance": {"balances": [
        {"asset": "USDT", "free": "70", "locked": "30"},
        {"asset": "BTC", "free": "0.001", "locked": "0.001"},
        {"asset": "VST", "free": "100000", "locked": "0"},
    ]},
    "/openApi/spot/v2/quote/ticker": [
        {"symbol": "BTC-USDT", "lastPrice": "50000", "closeTime": 1700000000000},
    ],
    "/openApi/swap/v3/user/balance": [
        {"asset": "USDT", "balance": "40", "equity": "50", "unrealizedProfit": "10"},
        {"asset": "USDC", "balance": "999", "equity": "999"},
    ],

}


def responses():
    return deepcopy(RESPONSES)
