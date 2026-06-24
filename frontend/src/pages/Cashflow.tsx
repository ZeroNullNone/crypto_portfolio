import { useMemo, useState } from "react";
import { api } from "../api";
import { fmt$ } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { useTranslation } from "../i18n/useTranslation";
import type { Account, CashflowEntryInput, CashflowKind } from "../types";

const RANGES = ["24H", "7D", "30D", "90D", "YTD", "ALL"];

function localDate(d = new Date()) {
  return d.toLocaleDateString("en-CA");
}

function localTime(d = new Date()) {
  return d.toTimeString().slice(0, 5);
}

function entryIso(date: string, time: string) {
  return new Date(`${date}T${time || "00:00"}`).toISOString();
}

function fmtEntryTime(iso: string) {
  return new Date(iso).toLocaleString();
}

export function Cashflow() {
  const t = useTranslation();
  const [range, setRange] = useState("30D");
  const [modalOpen, setModalOpen] = useState(false);
  const cashflow = useApi(() => api.cashflow(range), [range], `cashflow:${range}`);
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");

  const entries = cashflow.data?.entries ?? [];

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>
            {t.cashflow.title}{" "}
            <span className="tiny" style={{ marginLeft: 10 }}>
              {t.cashflow.subhead}
            </span>
          </h2>
          <div className="tiny mt-8">{t.cashflow.subtitle}</div>
        </div>
        <button
          type="button"
          className="wbtn primary"
          onClick={() => setModalOpen(true)}
        >
          {t.cashflow.addEntry}
        </button>
      </div>

      <div className="col" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 6 }}>
          {RANGES.map((r) => (
            <span
              key={r}
              className={"pill" + (range === r ? " active" : "")}
              onClick={() => setRange(r)}
            >
              {r}
            </span>
          ))}
        </div>

        <div className="grid g-3">
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.inflows30d} · {range}</span>
            <span className="v accent-2">
              {fmt$(cashflow.data?.inflows_30d ?? 0)}
            </span>
          </div>
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.outflows30d} · {range}</span>
            <span className="v accent">
              −{fmt$(Math.abs(cashflow.data?.outflows_30d ?? 0))}
            </span>
          </div>
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.net30d} · {range}</span>
            <span
              className={
                "v " + ((cashflow.data?.net_30d ?? 0) >= 0 ? "accent-2" : "accent")
              }
            >
              {(cashflow.data?.net_30d ?? 0) >= 0 ? "+" : "−"}
              {fmt$(Math.abs(cashflow.data?.net_30d ?? 0))}
            </span>
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="mono-xs mb-8">{t.cashflow.transferLedger}</div>
          {entries.length === 0 ? (
            <div className="tiny muted" style={{ padding: "12px 0" }}>
              {t.cashflow.transferEmpty}
            </div>
          ) : (
            <table className="sk">
              <thead>
                <tr>
                  <th>{t.cashflow.colDate}</th>
                  <th>{t.cashflow.colType}</th>
                  <th>{t.cashflow.colAccount}</th>
                  <th>{t.cashflow.colNote}</th>
                  <th className="num">{t.cashflow.colAmount}</th>
                  <th style={{ width: 28 }}></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{fmtEntryTime(entry.t)}</td>
                    <td>{entry.kind === "deposit" ? t.cashflow.deposit : t.cashflow.withdraw}</td>
                    <td>{entry.account_name || t.cashflow.portfolioLevel}</td>
                    <td>
                      <span className="tiny">{entry.note || ""}</span>
                    </td>
                    <td
                      className={
                        "num " + (entry.kind === "deposit" ? "accent-2" : "accent")
                      }
                    >
                      {entry.kind === "deposit" ? "+" : "−"}
                      {fmt$(entry.amount_usd)}
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="wbtn"
                        style={{ padding: "2px 7px" }}
                        onClick={async () => {
                          await api.deleteCashflowEntry(entry.id);
                          cashflow.refetch();
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modalOpen && (
        <CashflowEntryModal
          accounts={accounts.data ?? []}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            cashflow.refetch();
          }}
        />
      )}
    </div>
  );
}

function CashflowEntryModal({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslation();
  const [kind, setKind] = useState<CashflowKind>("deposit");
  const [date, setDate] = useState(localDate());
  const [time, setTime] = useState(localTime());
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSave = useMemo(() => Number(amount) > 0 && !busy, [amount, busy]);

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    const body: CashflowEntryInput = {
      kind,
      amount_usd: Number(amount),
      t: entryIso(date, time),
      account_id: accountId || null,
      note: note.trim() || null,
    };
    try {
      await api.createCashflowEntry(body);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t.cashflow.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(26,24,20,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sketch-box p-16"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(720px, 96vw)", background: "var(--paper)" }}
      >
        <div className="row between mb-8">
          <div className="mono-xs">{t.cashflow.recordTitle}</div>
          <button className="wbtn" onClick={onClose}>×</button>
        </div>
        <div className="grid g-4" style={{ alignItems: "end" }}>
          <div>
            <div className="mono-xs mb-8">{t.cashflow.type}</div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={kind === "deposit" ? "wbtn primary" : "wbtn"}
                onClick={() => setKind("deposit")}
              >
                {t.cashflow.deposit}
              </button>
              <button
                type="button"
                className={kind === "withdraw" ? "wbtn primary" : "wbtn"}
                onClick={() => setKind("withdraw")}
              >
                {t.cashflow.withdraw}
              </button>
            </div>
          </div>
          <label>
            <div className="mono-xs mb-8">{t.cashflow.date}</div>
            <input value={date} onChange={(e) => setDate(e.target.value)} type="date" />
          </label>
          <label>
            <div className="mono-xs mb-8">{t.cashflow.time}</div>
            <input value={time} onChange={(e) => setTime(e.target.value)} type="time" />
          </label>
          <label>
            <div className="mono-xs mb-8">{t.cashflow.amountUsd}</div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              type="number"
              min="0"
              step="0.01"
            />
          </label>
        </div>
        <label style={{ display: "block", marginTop: 12 }}>
          <div className="mono-xs mb-8">{t.cashflow.account}</div>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t.cashflow.portfolioLevel}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          <div className="mono-xs mb-8">{t.cashflow.note}</div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.cashflow.notePlaceholder}
          />
        </label>
        {err && <div className="tiny accent mt-8">{err}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="wbtn" onClick={onClose}>{t.common.cancel}</button>
          <button className="wbtn primary" disabled={!canSave} onClick={submit}>
            {busy ? t.common.loading : t.cashflow.addEntry}
          </button>
        </div>
      </div>
    </div>
  );
}
