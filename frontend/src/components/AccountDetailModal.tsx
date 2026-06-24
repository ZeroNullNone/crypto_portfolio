import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { ChartPlaceholder, Delta, LineChart } from "../lib/charts";
import { fmt$, sensitiveText } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { useTranslation } from "../i18n/useTranslation";
import type { AccountHistoryPointInput, AccountSnapshot, Holding } from "../types";

type FilterMode = "all" | "tok" | "pos";
type HoldingsGroupBy = "assets" | "chain";
type HistoryDraft = {
  key: string;
  id?: number;
  date: string;
  time: string;
  bal: string;
};

const HIDE_THRESHOLD_USD = 1;
const EXCHANGE_CHAIN_PREFIXES = [
  "binance",
  "bybit",
  "bitget",
  "okx",
  "gate",
  "extended",
  "derive",
  "hyperliquid",
];

function exchangePrefix(chain: string): string | null {
  const lower = chain.toLowerCase();
  return EXCHANGE_CHAIN_PREFIXES.find(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}-`),
  ) ?? null;
}

function accountBucketLabel(chain: string): string {
  const lower = chain.toLowerCase();
  if (lower === "custom") return "custom";
  const prefix = exchangePrefix(chain);
  if (!prefix) return chain;
  const bucket = lower.slice(prefix.length).replace(/^-/, "");
  if (!bucket) return prefix;
  if (bucket.includes("earn")) return "Earn";
  if (bucket.includes("spot")) return "Spot";
  if (bucket.includes("funding")) return "Funding";
  if (bucket.includes("copy")) return "Copy trading";
  if (bucket.includes("tradingbot")) return "Trading bot";
  if (bucket.includes("portfolio")) return "Portfolio";
  if (bucket.includes("usdm")) return "USD-M";
  if (bucket.includes("coinm")) return "COIN-M";
  return bucket
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function chainBadgeLabel(chain: string): string {
  return exchangePrefix(chain) ?? chain;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTimeValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function snapshotDraft(s: AccountSnapshot): HistoryDraft {
  const d = new Date(s.synced_at);
  return {
    key: String(s.id),
    id: s.id,
    date: localDateValue(d),
    time: localTimeValue(d),
    bal: String(Math.round((s.bal || 0) * 100) / 100),
  };
}

function defaultHistoryDraft(): HistoryDraft {
  return {
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    date: localDateValue(new Date()),
    time: "23:59",
    bal: "",
  };
}

function historyInput(draft: HistoryDraft): AccountHistoryPointInput | null {
  const bal = Number(draft.bal.replace(/[$,\s]/g, ""));
  const t = new Date(`${draft.date}T${draft.time || "23:59"}`);
  if (!draft.date || Number.isNaN(t.getTime()) || !Number.isFinite(bal) || bal < 0) {
    return null;
  }
  return { bal, synced_at: t.toISOString() };
}

function HoldingIcon({ holding, size = 24 }: { holding: Holding; size?: number }) {
  const [failed, setFailed] = useState(false);
  const label = holding.sym.slice(0, 3) || "?";
  const showImg = holding.logo && !failed;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: holding.c,
        border: "1.5px solid var(--line)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: Math.max(8, Math.round(size * 0.38)),
        color: "#fff",
        fontWeight: 600,
        overflow: "hidden",
      }}
    >
      {showImg ? (
        <img
          src={holding.logo!}
          alt={holding.sym}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        label
      )}
    </div>
  );
}

interface ProtocolGroup {
  proto: string;
  chain: string;
  logo?: string | null;
  color: string;
  usd: number;
  d: number;
  positions: Holding[];
}

interface ChainGroup {
  chain: string;
  logo?: string | null;
  color: string;
  usd: number;
  d: number;
  holdings: Holding[];
}

function groupPositionsByProtocol(
  positions: Holding[],
  isExcluded: (p: Holding) => boolean,
): ProtocolGroup[] {
  const byProto = new Map<string, ProtocolGroup>();
  for (const p of positions) {
    const key = p.proto || "—";
    let bucket = byProto.get(key);
    if (!bucket) {
      bucket = {
        proto: key,
        chain: p.chain,
        logo: p.proto_logo || p.logo,
        color: p.c,
        usd: 0,
        d: 0,
        positions: [],
      };
      byProto.set(key, bucket);
    }
    bucket.positions.push(p);
    if (!isExcluded(p)) {
      bucket.usd += p.usd;
      bucket.d += (p.d || 0) * p.usd;
    }
  }
  const groups = Array.from(byProto.values()).map((g) => ({
    ...g,
    d: g.usd !== 0 ? g.d / g.usd : 0,
  }));
  groups.sort((a, b) => b.usd - a.usd);
  for (const g of groups) g.positions.sort((a, b) => b.usd - a.usd);
  return groups;
}

function groupHoldingsByChain(
  holdings: Holding[],
  isExcluded: (h: Holding) => boolean,
): ChainGroup[] {
  const byChain = new Map<string, ChainGroup>();
  for (const h of holdings) {
    const key = h.chain || "unknown";
    let bucket = byChain.get(key);
    if (!bucket) {
      bucket = {
        chain: key,
        logo: h.chain_logo || null,
        color: h.c,
        usd: 0,
        d: 0,
        holdings: [],
      };
      byChain.set(key, bucket);
    }
    bucket.holdings.push(h);
    if (!isExcluded(h)) {
      bucket.usd += h.usd;
      bucket.d += (h.d || 0) * h.usd;
    }
  }
  const groups = Array.from(byChain.values()).map((g) => ({
    ...g,
    d: g.usd !== 0 ? g.d / g.usd : 0,
  }));
  groups.sort((a, b) => b.usd - a.usd);
  for (const g of groups) g.holdings.sort((a, b) => b.usd - a.usd);
  return groups;
}

export function AccountDetailModal({
  accountId,
  onClose,
  onHistoryChange,
}: {
  accountId: string;
  onClose: () => void;
  onHistoryChange?: () => void;
}) {
  const t = useTranslation();
  const detail = useApi(
    () => api.getAccount(accountId),
    [accountId],
    `account:${accountId}`,
  );
  const history = useApi(
    () => api.balanceHistory("ALL"),
    [],
    "balance:history:ALL",
  );
  const snapshots = useApi(
    () => api.accountSnapshots(accountId),
    [accountId],
    `account:${accountId}:snapshots`,
  );

  const [filter, setFilter] = useState<FilterMode>("all");
  const [holdingsGroupBy, setHoldingsGroupBy] = useState<HoldingsGroupBy>("assets");
  const [hideDust, setHideDust] = useState(true);
  const [expandedProtos, setExpandedProtos] = useState<Set<string>>(new Set());
  const [collapsedChains, setCollapsedChains] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newHistoryRows, setNewHistoryRows] = useState<HistoryDraft[]>([]);
  const [editingHistory, setEditingHistory] = useState<Record<number, HistoryDraft>>({});
  const [deletedHistoryIds, setDeletedHistoryIds] = useState<Set<number>>(new Set());
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyErr, setHistoryErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setHistoryOpen(false);
    setNewHistoryRows([]);
    setEditingHistory({});
    setDeletedHistoryIds(new Set());
    setHistoryErr(null);
  }, [accountId]);

  const toggleProto = (name: string) => {
    setExpandedProtos((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleChain = (name: string) => {
    setCollapsedChains((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const existingHistoryRows = (snapshots.data ?? [])
    .filter((row) => !deletedHistoryIds.has(row.id))
    .sort(
      (a, b) =>
        new Date(a.synced_at).getTime() - new Date(b.synced_at).getTime(),
    );
  const historyDrafts = [...Object.values(editingHistory), ...newHistoryRows];
  const historyHasChanges =
    historyDrafts.length > 0 || deletedHistoryIds.size > 0;
  const historyCanSave =
    historyHasChanges &&
    !historyBusy &&
    historyDrafts.every((draft) => historyInput(draft) !== null);

  const updateExistingHistory = (id: number, patch: Partial<HistoryDraft>) => {
    setEditingHistory((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  };

  const updateNewHistory = (key: string, patch: Partial<HistoryDraft>) => {
    setNewHistoryRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const resetHistoryDrafts = () => {
    setNewHistoryRows([]);
    setEditingHistory({});
    setDeletedHistoryIds(new Set());
    setHistoryErr(null);
  };

  const saveHistory = async () => {
    if (!detail.data || !historyCanSave) return;
    setHistoryBusy(true);
    setHistoryErr(null);
    try {
      for (const id of deletedHistoryIds) {
        await api.deleteAccountSnapshot(detail.data.id, id);
      }
      for (const draft of Object.values(editingHistory)) {
        if (draft.id == null) continue;
        const body = historyInput(draft);
        if (!body) throw new Error(t.accounts.historyInvalid);
        await api.updateAccountSnapshot(detail.data.id, draft.id, body);
      }
      for (const draft of newHistoryRows) {
        const body = historyInput(draft);
        if (!body) throw new Error(t.accounts.historyInvalid);
        await api.createAccountSnapshot(detail.data.id, body);
      }
      resetHistoryDrafts();
      snapshots.refetch();
      history.refetch();
      detail.refetch();
      onHistoryChange?.();
    } catch (err) {
      setHistoryErr(err instanceof Error ? err.message : t.common.failed);
    } finally {
      setHistoryBusy(false);
    }
  };

  const holdings: Holding[] = detail.data?.holdings ?? [];
  const excludedKeys = detail.data?.excluded_keys ?? [];
  const excludedSet = useMemo(() => new Set(excludedKeys), [excludedKeys]);
  const isExcluded = (h: Holding): boolean =>
    h.key ? excludedSet.has(h.key) : !!h.excluded;
  const visibleHoldings = hideDust
    ? holdings.filter(
        (h) => Math.abs(h.usd) >= HIDE_THRESHOLD_USD || isExcluded(h),
      )
    : holdings;
  const tokens = visibleHoldings.filter((h) => h.kind === "tok");
  const positions = visibleHoldings.filter((h) => h.kind === "pos");
  const filteredVisibleHoldings =
    filter === "tok" ? tokens : filter === "pos" ? positions : visibleHoldings;
  const tokCount = tokens.length;
  const posCount = positions.length;
  const protoGroups = useMemo(
    () => groupPositionsByProtocol(positions, isExcluded),
    [positions, excludedSet],
  );
  const chainGroups = useMemo(
    () => groupHoldingsByChain(filteredVisibleHoldings, isExcluded),
    [filteredVisibleHoldings, excludedSet],
  );
  const primaryGroupByLabel =
    detail.data?.source === "onchain"
      ? t.accounts.groupByChain
      : t.accounts.groupByAccounts;

  const showTokens = filter === "all" || filter === "tok";
  const showPositions = filter === "all" || filter === "pos";

  const excludedRowStyle = (excluded: boolean) =>
    excluded
      ? ({
          opacity: 0.45,
          color: "var(--muted)",
        } as const)
      : undefined;
  const excludedUsdStyle = (excluded: boolean) =>
    excluded ? ({ textDecoration: "line-through" } as const) : undefined;

  const renderHoldingRow = (r: Holding, key: string, indent = 0) => {
    const ex = isExcluded(r);
    return (
      <tr key={key} style={excludedRowStyle(ex)}>
        <td style={indent ? { paddingLeft: indent } : undefined}>
          <HoldingIcon holding={r} size={indent ? 20 : 24} />
        </td>
        <td style={indent ? { paddingLeft: indent + 8 } : undefined}>
          <b>{r.kind === "tok" ? r.sym : r.name}</b>{" "}
          {r.kind === "tok" && (
            <span style={{ color: "var(--muted)" }}>{r.name}</span>
          )}
          {ex && (
            <span
              className="tiny"
              style={{
                marginLeft: 6,
                padding: "0 5px",
                border: "1px solid var(--line)",
                borderRadius: 3,
                color: "var(--ink-2)",
                fontSize: 9,
                letterSpacing: 0.4,
                verticalAlign: "middle",
              }}
            >
              {t.accounts.excludedTag}
            </span>
          )}
        </td>
        <td>{r.proto}</td>
        <td>
          <span
            className="src chain"
            style={{
              borderColor: "var(--line)",
              color: "var(--ink-2)",
            }}
          >
            {chainBadgeLabel(r.chain)}
          </span>
        </td>
        <td className="num">{sensitiveText(r.amt)}</td>
        <td className="num">
          {r.price}
          {r.price_source === "api" && (
            <span
              className="tiny"
              title={t.accounts.livePriceTip}
              style={{
                marginLeft: 6,
                padding: "0 5px",
                border: "1px solid var(--line)",
                borderRadius: 3,
                color: "var(--ink-2)",
                fontSize: 9,
                letterSpacing: 0.4,
                verticalAlign: "middle",
              }}
            >
              {t.accounts.live}
            </span>
          )}
        </td>
        <td className="num">
          <b style={excludedUsdStyle(ex)}>
            {r.usd < 0 ? "−" : ""}
            {fmt$(Math.abs(r.usd))}
          </b>
        </td>
        <td className="num">
          <Delta v={r.d} />
        </td>
      </tr>
    );
  };

  const renderHistoryEditRow = (
    draft: HistoryDraft,
    update: (patch: Partial<HistoryDraft>) => void,
    remove: () => void,
  ) => (
    <tr key={draft.key}>
      <td>
        <input
          className="winput"
          type="date"
          value={draft.date}
          onChange={(e) => update({ date: e.target.value })}
        />
      </td>
      <td>
        <input
          className="winput"
          type="time"
          value={draft.time}
          onChange={(e) => update({ time: e.target.value })}
        />
      </td>
      <td>
        <input
          className="winput"
          inputMode="decimal"
          value={draft.bal}
          onChange={(e) => update({ bal: e.target.value })}
        />
      </td>
      <td className="num">
        <button type="button" className="wbtn accent" onClick={remove}>
          {t.accounts.historyRemove}
        </button>
      </td>
    </tr>
  );

  const renderHistoryRow = (row: AccountSnapshot) => {
    const editing = editingHistory[row.id];
    if (editing) {
      return renderHistoryEditRow(
        editing,
        (patch) => updateExistingHistory(row.id, patch),
        () => {
          setEditingHistory((prev) => {
            const next = { ...prev };
            delete next[row.id];
            return next;
          });
          setDeletedHistoryIds((prev) => new Set(prev).add(row.id));
        },
      );
    }
    const d = new Date(row.synced_at);
    return (
      <tr key={row.id}>
        <td>{localDateValue(d)}</td>
        <td>{localTimeValue(d)}</td>
        <td className="num">{fmt$(row.bal)}</td>
        <td className="num">
          {row.editable ? (
            <button
              type="button"
              className="wbtn"
              onClick={() =>
                setEditingHistory((prev) => ({
                  ...prev,
                  [row.id]: snapshotDraft(row),
                }))
              }
            >
              {t.accounts.historyEdit}
            </button>
          ) : (
            <span className="tiny" style={{ color: "var(--muted)" }}>
              {t.common.synced}
            </span>
          )}
        </td>
      </tr>
    );
  };

  const modal = (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(26,24,20,0.45)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
        isolation: "isolate",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sketch-box thick"
        style={{
          width: "100%",
          maxWidth: 960,
          margin: "auto",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.18)",
          padding: 0,
        }}
      >
        <div
          className="row between"
          style={{
            padding: "12px 16px",
            borderBottom: "1.5px solid var(--line)",
            alignItems: "center",
          }}
        >
          <span className="mono-xs" style={{ color: "var(--muted)" }}>
            account details
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              color: "var(--muted)",
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div className="col" style={{ gap: 12, padding: 16 }}>
          <div className="sketch-box p-16">
            {detail.data ? (
              <>
                <div className="row between">
                  <div>
                    <span className={"src " + detail.data.source}>
                      {detail.data.source}
                    </span>
                    <div
                      className="row"
                      style={{ gap: 10, alignItems: "center", marginTop: 4 }}
                    >
                      <div className="head" style={{ fontSize: 28 }}>
                        {detail.data.name}
                      </div>
                    </div>
                    <div className="tiny" style={{ fontFamily: "var(--mono)" }}>
                      {detail.data.addr}
                      {detail.data.chain && <> · {detail.data.chain}</>} ·{" "}
                      {detail.data.group}
                    </div>
                    {detail.data.note && (
                      <div
                        className="tiny"
                        style={{
                          marginTop: 6,
                          color: "var(--ink-2)",
                          whiteSpace: "pre-wrap",
                          maxWidth: 520,
                        }}
                      >
                        {detail.data.note}
                      </div>
                    )}
                  </div>
                  <div
                    className="col"
                    style={{ alignItems: "flex-end", gap: 4 }}
                  >
                    <div className="head" style={{ fontSize: 32 }}>
                      {fmt$(detail.data.bal)}
                    </div>
                    <Delta v={detail.data.d} />
                    {detail.data.synced_at && (
                      <span className="tiny" style={{ color: "var(--muted)" }}>
                        {t.accounts.syncedAt(
                          new Date(detail.data.synced_at).toLocaleString(),
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ height: 140, marginTop: 10 }}>
                  {(history.data?.per_account[detail.data.id]?.length ?? 0) >= 1 ? (
                    <LineChart
                      seed={11}
                      fill="#2e8b6b"
                      series={history.data!.per_account[detail.data.id]}
                    />
                  ) : (
                    <ChartPlaceholder />
                  )}
                </div>
              </>
            ) : (
              <div className="tiny muted">{t.common.loading}</div>
            )}
          </div>

          {detail.data &&
            (historyOpen ? (
              <div className="sketch-box p-16">
                <div className="row between mb-12">
                  <span className="mono-xs">{t.accounts.balanceHistoryTitle}</span>
                  <button
                    type="button"
                    className="wbtn"
                    onClick={() => {
                      setHistoryOpen(false);
                      resetHistoryDrafts();
                    }}
                    aria-label={t.common.close}
                    style={{ width: 34, height: 34, padding: 0 }}
                  >
                    ×
                  </button>
                </div>
                <div className="tiny" style={{ color: "var(--muted)", marginBottom: 12 }}>
                  {t.accounts.balanceHistoryHelp}
                </div>
                <table className="sk">
                  <thead>
                    <tr>
                      <th>{t.accounts.historyDate}</th>
                      <th>{t.accounts.historyTime}</th>
                      <th className="num">{t.accounts.historyBalance}</th>
                      <th className="num"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {newHistoryRows.map((row) =>
                      renderHistoryEditRow(
                        row,
                        (patch) => updateNewHistory(row.key, patch),
                        () =>
                          setNewHistoryRows((prev) =>
                            prev.filter((draft) => draft.key !== row.key),
                          ),
                      ),
                    )}
                    {existingHistoryRows.map(renderHistoryRow)}
                    {!snapshots.loading &&
                      newHistoryRows.length === 0 &&
                      existingHistoryRows.length === 0 && (
                        <tr>
                          <td colSpan={4} className="tiny muted">
                            {t.accounts.historyEmpty}
                          </td>
                        </tr>
                      )}
                  </tbody>
                </table>
                {snapshots.loading && (
                  <div className="tiny muted" style={{ paddingTop: 8 }}>
                    {t.common.loading}
                  </div>
                )}
                {(historyErr || snapshots.error) && (
                  <div className="tiny" style={{ color: "var(--accent)", paddingTop: 8 }}>
                    {historyErr || snapshots.error?.message}
                  </div>
                )}
                <div className="row between" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="wbtn"
                    onClick={() =>
                      setNewHistoryRows((prev) => [defaultHistoryDraft(), ...prev])
                    }
                    disabled={historyBusy}
                  >
                    {t.accounts.historyAdd}
                  </button>
                  <button
                    type="button"
                    className="wbtn primary"
                    onClick={saveHistory}
                    disabled={!historyCanSave}
                  >
                    {historyBusy ? t.common.loading : t.accounts.historySave}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="wbtn"
                onClick={() => setHistoryOpen(true)}
                style={{ width: "100%" }}
              >
                {t.accounts.editBalanceHistory}
              </button>
            ))}

          {detail.data && (
            <div className="sketch-box p-16">
	              <div className="row between mb-8">
	                <div className="row" style={{ gap: 8, alignItems: "center" }}>
	                  <span className="mono-xs">{t.accounts.holdingsTitle}</span>
	                  <span className="mono-xs">|</span>
	                  <span className="mono-xs">{t.accounts.groupBy}</span>
	                  <span className="segmented">
	                    <button
	                      type="button"
	                      className={holdingsGroupBy === "chain" ? "active" : ""}
	                      onClick={() => setHoldingsGroupBy("chain")}
	                    >
	                      {primaryGroupByLabel}
	                    </button>
	                    <button
	                      type="button"
	                      className={holdingsGroupBy === "assets" ? "active" : ""}
	                      onClick={() => setHoldingsGroupBy("assets")}
	                    >
	                      {t.accounts.groupByAssets}
	                    </button>
	                  </span>
	                </div>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <label
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      gap: 4,
                      alignItems: "center",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hideDust}
                      onChange={(e) => setHideDust(e.target.checked)}
                    />
                    {t.accounts.hideDust}
                  </label>
                  <div className="row" style={{ gap: 6 }}>
                    <span
                      className={"pill" + (filter === "all" ? " active" : "")}
                      onClick={() => setFilter("all")}
                    >
                      {t.accounts.filterAll} ({tokCount + posCount})
                    </span>
                    <span
                      className={"pill" + (filter === "tok" ? " active" : "")}
                      onClick={() => setFilter("tok")}
                    >
                      {t.accounts.filterTokens} ({tokCount})
                    </span>
                    <span
                      className={"pill" + (filter === "pos" ? " active" : "")}
                      onClick={() => setFilter("pos")}
                    >
                      {t.accounts.filterDefi} ({protoGroups.length})
                    </span>
                  </div>
                </div>
              </div>
              {holdings.length === 0 ? (
                <div className="tiny muted" style={{ padding: "12px 0" }}>
                  {t.accounts.noHoldings}
                </div>
              ) : visibleHoldings.length === 0 ? (
                <div className="tiny muted" style={{ padding: "12px 0" }}>
                  {t.accounts.allDust}
                </div>
              ) : (
                <table className="sk">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>{t.accounts.colAssetPosition}</th>
                      <th>{t.accounts.colProtocol}</th>
                      <th>{t.accounts.colChainEx}</th>
                      <th className="num">{t.accounts.colAmount}</th>
                      <th className="num">{t.accounts.colPrice}</th>
                      <th className="num">{t.accounts.colUsdValue}</th>
                      <th className="num">{t.accounts.col24h}</th>
                    </tr>
	                  </thead>
	                  <tbody>
	                    {holdingsGroupBy === "chain" &&
	                      chainGroups.map((g) => {
	                        const collapsed = collapsedChains.has(g.chain);
	                        const chainLabel = accountBucketLabel(g.chain);
	                        const headerHolding: Holding = {
	                          kind: "tok",
	                          sym: chainLabel.slice(0, 3),
	                          name: chainLabel,
	                          proto: "—",
	                          chain: g.chain,
	                          amt: "",
	                          price: "",
	                          usd: g.usd,
	                          d: g.d,
	                          c: g.color,
	                          logo: g.logo,
	                        };
	                        return (
	                          <Fragment key={`chain-${g.chain}`}>
	                            <tr
	                              onClick={() => toggleChain(g.chain)}
	                              style={{
	                                cursor: "pointer",
	                                background: "rgba(46,139,107,0.08)",
	                              }}
	                            >
	                              <td>
	                                <HoldingIcon holding={headerHolding} />
	                              </td>
	                              <td>
	                                <span
	                                  style={{
	                                    display: "inline-block",
	                                    width: 12,
	                                    fontFamily: "var(--mono)",
	                                  }}
	                                >
	                                  {collapsed ? "▸" : "▾"}
	                                </span>
	                                <b>{chainLabel}</b>{" "}
	                                <span className="chip" style={{ marginLeft: 6 }}>
	                                  {g.holdings.length}
	                                </span>
	                              </td>
	                              <td>—</td>
	                              <td>—</td>
	                              <td className="num">—</td>
	                              <td className="num">—</td>
	                              <td className="num">
	                                <b>{fmt$(Math.abs(g.usd))}</b>
	                              </td>
	                              <td className="num">
	                                <Delta v={g.d} />
	                              </td>
	                            </tr>
	                            {!collapsed &&
	                              g.holdings.map((r, i) =>
	                                renderHoldingRow(r, `chain-${g.chain}-${i}`, 16),
	                              )}
	                          </Fragment>
	                        );
	                      })}
	                    {holdingsGroupBy === "assets" &&
	                      showTokens &&
	                      tokens.map((r, i) => {
                        const ex = isExcluded(r);
                        return (
                          <tr key={`tok-${i}`} style={excludedRowStyle(ex)}>
                            <td>
                              <HoldingIcon holding={r} />
                            </td>
                            <td>
                              <b>{r.sym}</b>{" "}
                              <span style={{ color: "var(--muted)" }}>{r.name}</span>
                              {ex && (
                                <span
                                  className="tiny"
                                  style={{
                                    marginLeft: 6,
                                    padding: "0 5px",
                                    border: "1px solid var(--line)",
                                    borderRadius: 3,
                                    color: "var(--ink-2)",
                                    fontSize: 9,
                                    letterSpacing: 0.4,
                                    verticalAlign: "middle",
                                  }}
                                >
                                  {t.accounts.excludedTag}
                                </span>
                              )}
                            </td>
                            <td>{r.proto}</td>
                            <td>
                              <span
                                className="src chain"
                                style={{
                                  borderColor: "var(--line)",
                                  color: "var(--ink-2)",
                                }}
                              >
                                {chainBadgeLabel(r.chain)}
                              </span>
                            </td>
                            <td className="num">{sensitiveText(r.amt)}</td>
                            <td className="num">
                              {r.price}
                              {r.price_source === "api" && (
                                <span
                                  className="tiny"
                                  title={t.accounts.livePriceTip}
                                  style={{
                                    marginLeft: 6,
                                    padding: "0 5px",
                                    border: "1px solid var(--line)",
                                    borderRadius: 3,
                                    color: "var(--ink-2)",
                                    fontSize: 9,
                                    letterSpacing: 0.4,
                                    verticalAlign: "middle",
                                  }}
                                >
                                  {t.accounts.live}
                                </span>
                              )}
                            </td>
                            <td className="num">
                              <b style={excludedUsdStyle(ex)}>
                                {r.usd < 0 ? "−" : ""}
                                {fmt$(Math.abs(r.usd))}
                              </b>
                            </td>
                            <td className="num">
                              <Delta v={r.d} />
                            </td>
                          </tr>
                        );
                      })}
	                    {holdingsGroupBy === "assets" &&
	                      showPositions &&
	                      protoGroups.map((g) => {
                        const expanded = expandedProtos.has(g.proto);
                        const headerHolding: Holding = {
                          kind: "pos",
                          sym: g.proto,
                          name: g.proto,
                          proto: g.proto,
                          chain: g.chain,
                          amt: "",
                          price: "",
                          usd: g.usd,
                          d: g.d,
                          c: g.color,
                          logo: g.logo,
                        };
                        return (
                          <Fragment key={`proto-${g.proto}`}>
                            <tr
                              onClick={() => toggleProto(g.proto)}
                              style={{ cursor: "pointer" }}
                            >
                              <td>
                                <HoldingIcon holding={headerHolding} />
                              </td>
                              <td>
                                <span
                                  style={{
                                    display: "inline-block",
                                    width: 12,
                                    fontFamily: "var(--mono)",
                                  }}
                                >
                                  {expanded ? "▾" : "▸"}
                                </span>
                                <b>{g.proto}</b>{" "}
                                <span className="chip" style={{ marginLeft: 6 }}>
                                  {t.accounts.positionsLabel(g.positions.length)}
                                </span>
                              </td>
                              <td>{g.proto}</td>
                              <td>
                                <span
                                  className="src chain"
                                  style={{
                                    borderColor: "var(--line)",
                                    color: "var(--ink-2)",
                                  }}
                                >
                                  {chainBadgeLabel(g.chain)}
                                </span>
                              </td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                              <td className="num">
                                <b>
                                  {g.usd < 0 ? "−" : ""}
                                  {fmt$(Math.abs(g.usd))}
                                </b>
                              </td>
                              <td className="num">
                                <Delta v={g.d} />
                              </td>
                            </tr>
                            {expanded &&
                              g.positions.map((r, i) => {
                                const ex = isExcluded(r);
                                return (
                                  <tr
                                    key={`pos-${g.proto}-${i}`}
                                    style={excludedRowStyle(ex)}
                                  >
                                    <td style={{ paddingLeft: 16 }}>
                                      <HoldingIcon holding={r} size={20} />
                                    </td>
                                    <td style={{ paddingLeft: 24 }}>
                                      <b>{r.name}</b>
                                      {ex && (
                                        <span
                                          className="tiny"
                                          style={{
                                            marginLeft: 6,
                                            padding: "0 5px",
                                            border: "1px solid var(--line)",
                                            borderRadius: 3,
                                            color: "var(--ink-2)",
                                            fontSize: 9,
                                            letterSpacing: 0.4,
                                            verticalAlign: "middle",
                                          }}
                                        >
                                          {t.accounts.excludedTag}
                                        </span>
                                      )}
                                    </td>
                                    <td>{r.proto}</td>
                                    <td>
                                      <span
                                        className="src chain"
                                        style={{
                                          borderColor: "var(--line)",
                                          color: "var(--ink-2)",
                                        }}
                                      >
                                        {chainBadgeLabel(r.chain)}
                                      </span>
                                    </td>
                                    <td className="num">{sensitiveText(r.amt)}</td>
                                    <td className="num">{r.price}</td>
                                    <td className="num">
                                      <b style={excludedUsdStyle(ex)}>
                                        {r.usd < 0 ? "−" : ""}
                                        {fmt$(Math.abs(r.usd))}
                                      </b>
                                    </td>
                                    <td className="num">
                                      <Delta v={r.d} />
                                    </td>
                                  </tr>
                                );
                              })}
                          </Fragment>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}
