// Run with Node 22.6+: node --experimental-strip-types --test tests/exchangeHoldings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { exchangeAssets } from "../src/lib/exchangeHoldings.ts";

function token(key, chain, member, qty, usd) {
  return { kind: "tok", sym: "BTC", chain, member, key, amt: "0.00", amt_raw: qty,
    usd: Math.round(usd * 100) / 100, balance_usd: usd, d: 0 };
}

const main = token("main", "bybit", "Main account", 0.00001, 0.65);
const child = token("sub", "bybit-funding", "Subaccount 17", 0.000011, 0.66);
const debt = token("debt", "bybit-unified", "Subaccount 23", -0.000001, -0.06);

test("dust and debt are netted by coin before filtering, without member details", () => {
  const [btc] = exchangeAssets([main, child, debt], () => false);
  assert.equal(btc.usd, 1.25);
  assert.ok(Math.abs(btc.amt_raw - 0.00002) < 1e-15);
  assert.ok(Math.abs(btc.price_raw - 62500) < 1e-8);
  assert.equal(btc.member, null);
  assert.equal(btc.chain, "bybit");
});

test("an asset keeps every exclusion key but totals only the included pieces", () => {
  const [partial] = exchangeAssets([main, child], h => h.key === "sub");
  assert.deepEqual(partial.componentKeys, ["main", "sub"]);
  assert.equal(partial.usd, 0.65);
  assert.equal(partial.excluded, false);
  const [excluded] = exchangeAssets([main, child], () => true);
  assert.equal(excluded.excluded, true);
  assert.equal(excluded.usd, 1.31);
});

test("wallet estimates never become coin quantities, including older snapshots", () => {
  const a = { ...main, sym: "BYBIT_EARN", key: "earn", usd: 10, balance_usd: 10 };
  const b = { ...child, sym: "Valuation only", valuation_only: true, usd: 5, balance_usd: 5 };
  const [estimate, btc] = exchangeAssets([a, b, main], () => false);
  assert.equal(estimate.sym, "Valuation only");
  assert.equal(estimate.usd, 15);
  assert.equal(estimate.amt_raw, null);
  assert.equal(estimate.price, "—");
  assert.equal(btc.usd, 0.65);
});
