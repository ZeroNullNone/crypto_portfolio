import { Fragment, useState, type ReactNode } from "react";
import type { Holding } from "../types";
import { fmt$ } from "../lib/format";

/** Account -> wallet -> original ledger rows, inside the existing holdings table. */
export function ExchangeMemberRows({ rows, label, isExcluded, render, actions }: {
  rows: Holding[]; label: (chain: string) => string; isExcluded: (h: Holding) => boolean;
  render: (h: Holding, key: string, indent: number) => ReactNode; actions?: boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const members = new Map<string, Map<string, Holding[]>>();
  for (const row of rows) {
    const member = row.member ?? (row.chain === "custom" ? "Custom assets" : "Main account");
    const wallets = members.get(member) ?? new Map<string, Holding[]>();
    members.set(member, wallets);
    const list = wallets.get(row.chain) ?? [];
    wallets.set(row.chain, list);
    list.push(row);
  }
  const ordered = [...members].sort(([a],[b]) => a === b ? 0 : a === "Main account" ? -1 : b === "Main account" ? 1 : a.localeCompare(b));
  return <>{ordered.map(([member, wallets]) => {
    const items = [...wallets.values()].flat();
    const value = items.reduce((s,h) => s + (isExcluded(h) ? 0 : h.balance_usd ?? h.usd), 0);
    return <Fragment key={member}>
      <tr style={{background: "rgba(46,139,107,0.08)"}}>
        <td colSpan={6}><button type="button" className="wbtn" aria-expanded={!closed.has(member)} onClick={() => setClosed(prev => {
          const next = new Set(prev); if (next.has(member)) next.delete(member); else next.add(member); return next;
        })}>{closed.has(member) ? "▸" : "▾"} {member}</button></td>
        <td className="num"><b>{fmt$(value)}</b></td><td/>{actions && <td/>}
      </tr>
      {!closed.has(member) && [...wallets].map(([chain, entries]) => <Fragment key={chain}>
        <tr><td colSpan={actions ? 9 : 8} className="mono-xs" style={{paddingLeft: 24}}>{label(chain)}</td></tr>
        {entries.map((h,i) => render(h, h.key ?? String(i), 24))}
      </Fragment>)}
    </Fragment>;
  })}</>;
}
