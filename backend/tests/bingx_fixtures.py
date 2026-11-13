"""Synthetic BingX responses shared by regression tests and the local UI harness."""
from copy import deepcopy

RESPONSES = {
    "/openApi/account/v1/allAccountBalance": {"result": [
        {"accountType": "sopt", "usdtBalance": "200"},
        {"accountType": "USDTMPerp", "usdtBalance": "50"}]},
    "/openApi/subAccount/v1/allAccountBalance": {"total": 2, "pageId": 1, "result": [
        {"subUid": "101", "accountBalances": [{"accountType": "sopt", "usdtBalance": "35"}]},
        {"subUid": "202", "accountBalances": [{"accountType": "USDTMPerp", "usdtBalance": "65"}]}]},
    "/openApi/subAccount/v1/assets": {"balances": [{"asset": "USDT", "free": "30", "locked": "5"}]},
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
