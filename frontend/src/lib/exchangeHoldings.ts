import type { Holding } from "../types";

export function familyExchange(chain: string) {
  return /^(bingx|bybit|binance)(?:-|$)/.exec(chain)?.[1];
}

export function valuationOnly(h: Holding): boolean {
  // Older snapshots predate the explicit valuation flag.
  return !!h.valuation_only || h.chain === "binance-summary" ||
    (familyExchange(h.chain) === "bybit" && h.sym.startsWith("BYBIT_"));
}

export function displayHolding(h: Holding): Holding {
  return valuationOnly(h) ? { ...h, sym: "Valuation only", name: "", amt: "—", price: "—", valuation_only: true } : h;
}

export function holdingKeys(h: Holding) {
  return h.componentKeys ?? (h.key ? [h.key] : []);
}

function amount(h: Holding): number | null {
  if (h.amt_raw != null) return h.amt_raw;
  // Old snapshots have rounded display strings only. Do not invent precision.
  const text = h.amt.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

/** Group before hiding dust. Keep the original keys so Include/Exclude still
 * affects just these ledger rows in this portfolio account. */
export function exchangeAssets(holdings: Holding[], excluded: (h: Holding) => boolean): Holding[] {
  const groups = new Map<string, Holding[]>();
  const out: Holding[] = [];
  for (const h of holdings) {
    const ex = familyExchange(h.chain);
    if (!ex || h.kind !== "tok") { out.push(h); continue; }
    const key = JSON.stringify([ex, valuationOnly(h) ? null : h.sym.toUpperCase()]);
    const g = groups.get(key);
    if (g) g.push(h); else groups.set(key, [h]);
  }
  for (const g of groups.values()) {
    const keys = g.flatMap(holdingKeys);
    const included = g.filter(h => !excluded(h));
    const shown = included.length ? included : g;
    const first = displayHolding(shown[0]);
    const usd = shown.reduce((s,h) => s + (h.balance_usd ?? h.usd), 0);
    const amounts = shown.map(amount);
    const qty = !first.valuation_only && amounts.every((n): n is number => n != null)
      ? amounts.reduce((s,n) => s+n, 0) : null;
    const price = qty ? usd / qty : null;
    out.push({ ...first, member: null, chain: familyExchange(first.chain)!, key: keys[0] ?? null,
      componentKeys: keys, excluded: !included.length, usd, balance_usd: usd,
      amt_raw: qty, price_raw: price,
      amt: qty == null ? "—" : qty.toLocaleString("en-US", { maximumFractionDigits: 10 }),
      price: price == null || price <= 0 ? "—" : "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: price >= 1 ? 4 : 8 }),
      name: included.length && included.length !== g.length ? "Partially excluded" : first.name,
      d: usd ? shown.reduce((s,h) => s + h.d * (h.balance_usd ?? h.usd), 0) / usd : 0 });
  }
  return out.sort((a,b) => Math.abs(b.usd) - Math.abs(a.usd));
}
