import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ChartPlaceholder, Delta, LineChart, Spark, StackedArea } from "../lib/charts";
import { fmt$k } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { SYNC_ALL_CONFIRM, SyncButton } from "../components/SyncButton";
import { useTranslation } from "../i18n/useTranslation";
import type { BalancePoint } from "../types";
import type { StackedSeries } from "../lib/charts";

const RANGES = ["24H", "7D", "30D", "90D", "YTD", "ALL"];
type BalanceView = "line" | "stack" | "heat" | "calendar";
const STACK_COLORS = [
  "#1a1814",
  "#d64933",
  "#2e8b6b",
  "#f2c14e",
  "#7a5fbd",
  "#8a8376",
  "#0f6f8f",
  "#b65c9a",
  "#5f7d3b",
  "#c77c2f",
];

export function Balance() {
  const t = useTranslation();
  const VIEWS = [
    { k: "line" as const, l: t.balance.viewLine },
    { k: "stack" as const, l: t.balance.viewStacked },
    { k: "heat" as const, l: t.balance.viewHeatmap },
    { k: "calendar" as const, l: t.balance.viewCalendar },
  ];
  const [range, setRange] = useState("30D");
  const [view, setView] = useState<BalanceView>("line");
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");
  const history = useApi(
    () => api.balanceHistory(range),
    [range],
    `balance:history:${range}`,
  );
  const allHistory = useApi(() => api.balanceHistory("ALL"), [], "balance:history:ALL");
  const chartTotal = view === "calendar" ? (allHistory.data?.total ?? []) : (history.data?.total ?? []);

  const refreshAfterSync = () => {
    accounts.refetch();
    history.refetch();
    allHistory.refetch();
  };
  const stackSeries = useMemo(
    () => toStackedSeries(history.data?.by_wallet),
    [history.data],
  );

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>{t.balance.title}</h2>
          <div className="tiny mt-8">{t.balance.subtitle}</div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <SyncButton
            sync={() => api.syncAll()}
            onDone={refreshAfterSync}
            label={t.balance.syncAll}
            confirm={SYNC_ALL_CONFIRM}
          />
        </div>
      </div>

      <div className="col" style={{ gap: 12 }}>
        <div className="row between">
          <div
            className="row"
            style={{
              gap: 4,
              border: "1.5px solid var(--line)",
              borderRadius: 8,
              padding: 3,
              background: "#fbfbfa",
            }}
          >
            {VIEWS.map((v) => (
              <span
                key={v.k}
                onClick={() => setView(v.k)}
                className="hand"
                style={{
                  padding: "3px 10px",
                  borderRadius: 5,
                  background: v.k === view ? "var(--ink)" : "transparent",
                  color: v.k === view ? "var(--paper)" : "inherit",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {v.l}
              </span>
            ))}
          </div>
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
        </div>

        <div className="sketch-box p-16">
          <div className="row between mb-8">
            <span className="mono-xs">
              {view === "calendar" ? t.balance.dailyBalanceTitle : t.balance.totalRange(range)}
            </span>
            <span className="tiny">
              {t.balance.snapshots(chartTotal.length)}
            </span>
          </div>
          <div style={{ height: view === "calendar" ? 430 : 220 }}>
            <BalanceHistoryChart
              view={view}
              total={chartTotal}
              stackSeries={stackSeries}
            />
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="mono-xs mb-8">{t.balance.perAccount}</div>
          <div className="grid g-3" style={{ gap: 10 }}>
            {accounts.data?.map((a, i) => (
              <div
                key={a.id}
                className="sketch-box p-12"
                style={{ gap: 4, display: "flex", flexDirection: "column" }}
              >
                <div className="row between">
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                    <b>{a.name}</b>
                  </span>
                  <span className={"src " + a.source}>{a.source}</span>
                </div>
                <div className="row between">
                  <span style={{ fontFamily: "var(--head)", fontSize: 20 }}>
                    {fmt$k(a.bal)}
                  </span>
                  <Delta v={a.d} />
                </div>
                <div style={{ height: 36 }}>
                  {(history.data?.per_account[a.id]?.length ?? 0) >= 1 ? (
                    <Spark
                      seed={i + 4}
                      w={260}
                      color={a.d >= 0 ? "#2e8b6b" : "#d64933"}
                      data={history.data!.per_account[a.id].map((p) => p.v)}
                    />
                  ) : (
                    <ChartPlaceholder message={t.balance.needsSnapshot} />
                  )}
                </div>
              </div>
            ))}
            {accounts.data?.length === 0 && (
              <div className="tiny muted">{t.balance.noAccounts}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function toStackedSeries(record: Record<string, BalancePoint[]> | undefined): StackedSeries[] {
  return Object.entries(record ?? {})
    .filter(([, points]) => points.some((p) => p.v > 0))
    .sort((a, b) => (b[1][b[1].length - 1]?.v ?? 0) - (a[1][a[1].length - 1]?.v ?? 0))
    .slice(0, 10)
    .map(([key, points], i) => ({
      key,
      points,
      color: STACK_COLORS[i % STACK_COLORS.length],
    }));
}

function BalanceHistoryChart({
  view,
  total,
  stackSeries,
}: {
  view: BalanceView;
  total: BalancePoint[];
  stackSeries: StackedSeries[];
}) {
  if (total.length < 1) return <ChartPlaceholder />;
  if (view === "line") {
    return <LineChart seed={18} fill="#2e8b6b" trend={0.5} series={total} xAxis rangeSelect />;
  }
  if (view === "stack") {
    return stackSeries.length > 0 ? (
      <StackedArea series={stackSeries} xAxis />
    ) : (
      <ChartPlaceholder />
    );
  }
  if (view === "calendar") return <BalanceCalendar series={total} />;
  return <BalanceHeatmap series={total} />;
}

function balanceDeltas(series: BalancePoint[]) {
  const sorted = [...series].sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );
  return sorted.map((point, i) => {
    const prev = sorted[i - 1]?.v ?? point.v;
    const pct = prev > 0 ? ((point.v - prev) / prev) * 100 : 0;
    return { ...point, pct, time: new Date(point.t).getTime() };
  }).filter((p) => Number.isFinite(p.time));
}

function heatColor(pct: number, maxAbs: number) {
  const intensity = Math.min(Math.abs(pct) / Math.max(maxAbs, 0.01), 1);
  const alpha = 0.16 + intensity * 0.64;
  return pct >= 0
    ? `rgba(46, 139, 107, ${alpha.toFixed(2)})`
    : `rgba(214, 73, 51, ${alpha.toFixed(2)})`;
}

function balanceCellColor(change: number, maxAbs: number) {
  if (change === 0) return "rgba(251,251,250,0.75)";
  const intensity = Math.min(Math.abs(change) / Math.max(maxAbs, 0.01), 1);
  const alpha = 0.08 + intensity * 0.18;
  return change > 0
    ? `rgba(46, 139, 107, ${alpha.toFixed(2)})`
    : `rgba(214, 73, 51, ${alpha.toFixed(2)})`;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthKey(d: Date): string {
  return dateKey(d).slice(0, 7);
}

function parseMonthKey(key: string): Date {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function shiftMonthKey(key: string, delta: number): string {
  const d = parseMonthKey(key);
  d.setMonth(d.getMonth() + delta);
  return monthKey(d);
}

function fmtSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "-";
  return sign + Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dailyBalanceRows(series: BalancePoint[]) {
  const daily = new Map<string, { key: string; day: Date; balance: number; time: number }>();
  for (const point of [...series].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())) {
    const d = new Date(point.t);
    const time = d.getTime();
    if (!Number.isFinite(time)) continue;
    const key = dateKey(d);
    daily.set(key, {
      key,
      day: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
      balance: point.v,
      time,
    });
  }
  return [...daily.values()]
    .sort((a, b) => a.time - b.time)
    .map((row, i, rows) => {
      const prev = rows[i - 1]?.balance ?? row.balance;
      const change = row.balance - prev;
      return {
        ...row,
        change: Math.round(change * 100) / 100,
        pct: prev > 0 ? (change / prev) * 100 : 0,
      };
    });
}

function BalanceHeatmap({ series }: { series: BalancePoint[] }) {
  const rows = balanceDeltas(series);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pct)), 0.01);
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(22px, 1fr))",
        alignContent: "stretch",
        gap: 4,
      }}
    >
      {rows.map((r) => (
        <div
          key={r.t}
          title={`${new Date(r.t).toLocaleString()} · ${fmt$k(r.v)} · ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`}
          style={{
            minHeight: 22,
            border: "1px solid rgba(26,24,20,0.25)",
            borderRadius: 3,
            background: heatColor(r.pct, maxAbs),
          }}
        />
      ))}
    </div>
  );
}

function BalanceCalendar({ series }: { series: BalancePoint[] }) {
  const t = useTranslation();
  const rows = dailyBalanceRows(series);
  const months = useMemo(() => {
    const keys = [...new Set(rows.map((r) => monthKey(r.day)))];
    return keys.sort();
  }, [rows]);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  useEffect(() => {
    if (months.length === 0) return;
    if (!selectedMonth || !months.includes(selectedMonth)) {
      setSelectedMonth(months[months.length - 1]);
    }
  }, [months, selectedMonth]);

  if (rows.length === 0) return <ChartPlaceholder />;

  const activeMonth = selectedMonth ?? months[months.length - 1];
  const monthStart = parseMonthKey(activeMonth);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const cellCount = Math.ceil((monthStart.getDay() + monthEnd.getDate()) / 7) * 7;
  const byDay = new Map(rows.map((r) => [r.key, r]));
  const cells = Array.from({ length: cellCount }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return { key: dateKey(d), d, point: byDay.get(dateKey(d)) };
  });
  const monthRows = rows.filter((r) => monthKey(r.day) === activeMonth);
  const baseRow = [...rows].reverse().find((r) => r.day < monthStart);
  const base = baseRow?.balance ?? monthRows[0]?.balance ?? 0;
  const monthBalance = monthRows[monthRows.length - 1]?.balance ?? 0;
  const monthChange = monthBalance - base;
  const maxAbs = Math.max(...monthRows.map((r) => Math.abs(r.change)), 0.01);
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  const canPrev = activeMonth > firstMonth;
  const canNext = activeMonth < lastMonth;
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="wbtn"
              disabled={!canPrev}
              onClick={() => setSelectedMonth(shiftMonthKey(activeMonth, -1))}
              aria-label={t.balance.prevMonth}
              title={t.balance.prevMonth}
              style={{ width: 30, height: 28, padding: 0, fontSize: 18, lineHeight: 1 }}
            >
              ‹
            </button>
            <span className="head" style={{ fontSize: 26, lineHeight: 1 }}>
              {activeMonth}
            </span>
            <button
              type="button"
              className="wbtn"
              disabled={!canNext}
              onClick={() => setSelectedMonth(shiftMonthKey(activeMonth, 1))}
              aria-label={t.balance.nextMonth}
              title={t.balance.nextMonth}
              style={{ width: 30, height: 28, padding: 0, fontSize: 18, lineHeight: 1 }}
            >
              ›
            </button>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 28, alignItems: "flex-end" }}>
          <div>
            <span className="mono-xs">{t.balance.monthBalance}</span>
            <span
              style={{ display: "block", fontFamily: "var(--head)", fontSize: 24 }}
            >
              {fmt$k(monthBalance)}
            </span>
          </div>
          <div>
            <span className="mono-xs">{t.balance.monthChange}</span>
            <span
              className={monthChange >= 0 ? "accent-2" : "accent"}
              style={{ display: "block", fontFamily: "var(--head)", fontSize: 24 }}
            >
              {fmtSignedUsd(monthChange)}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 8,
          fontFamily: "var(--mono)",
          fontSize: 12,
          textAlign: "center",
        }}
      >
        {weekdays.map((day, i) => (
          <div key={`${day}-${i}`} style={{ color: "var(--ink)", paddingBottom: 2 }}>
            {day}
          </div>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gridAutoRows: "minmax(52px, 1fr)",
          gap: 8,
        }}
      >
        {cells.map((cell) => {
          const inMonth = monthKey(cell.d) === activeMonth;
          const change = cell.point?.change ?? 0;
          return (
            <div
              key={cell.key}
              title={
                cell.point
                  ? `${cell.d.toLocaleDateString()} · ${fmt$k(cell.point.balance)} · ${fmtSignedUsd(cell.point.change)} · ${cell.point.pct >= 0 ? "+" : "-"}${Math.abs(cell.point.pct).toFixed(2)}%`
                  : cell.d.toLocaleDateString()
              }
              style={{
                border: "1px solid rgba(26,24,20,0.12)",
                borderRadius: 6,
                background: cell.point && inMonth ? balanceCellColor(change, maxAbs) : "rgba(251,251,250,0.58)",
                opacity: inMonth ? 1 : 0.34,
                padding: "8px 6px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: cell.point ? "center" : "flex-start",
                gap: 5,
                overflow: "hidden",
              }}
            >
              <div className="head" style={{ fontSize: 18, lineHeight: 1 }}>
                {cell.d.getDate()}
              </div>
              {cell.point && inMonth && (
                <div
                  className={change >= 0 ? "accent-2" : "accent"}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {fmt$k(cell.point.balance)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
