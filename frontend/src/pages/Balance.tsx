import { useMemo, useState } from "react";
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
  const [view, setView] = useState<BalanceView>("heat");
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");
  const history = useApi(
    () => api.balanceHistory(range),
    [range],
    `balance:history:${range}`,
  );

  const refreshAfterSync = () => {
    accounts.refetch();
    history.refetch();
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
            <span className="mono-xs">{t.balance.totalRange(range)}</span>
            <span className="tiny">
              {t.balance.snapshots(history.data?.total.length ?? 0)}
            </span>
          </div>
          <div style={{ height: view === "calendar" ? 260 : 220 }}>
            <BalanceHistoryChart
              view={view}
              total={history.data?.total ?? []}
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
  const rows = balanceDeltas(series);
  if (rows.length === 0) return <ChartPlaceholder />;
  const byDay = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byDay.set(new Date(r.t).toISOString().slice(0, 10), r);
  const first = new Date(rows[0].time);
  const last = new Date(rows[rows.length - 1].time);
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay());
  const days = Math.ceil((last.getTime() - start.getTime()) / 86400000) + 1;
  const cells = Array.from({ length: Math.max(days, 7) }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    return { key, d, point: byDay.get(key) };
  });
  const weeks = Math.ceil(cells.length / 7);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pct)), 0.01);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${weeks}, minmax(18px, 1fr))`,
        gridAutoFlow: "column",
        gridTemplateRows: "repeat(7, minmax(18px, 1fr))",
        gap: 4,
        height: "100%",
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          title={
            cell.point
              ? `${cell.d.toLocaleDateString()} · ${fmt$k(cell.point.v)} · ${cell.point.pct >= 0 ? "+" : ""}${cell.point.pct.toFixed(2)}%`
              : cell.d.toLocaleDateString()
          }
          style={{
            border: "1px solid rgba(26,24,20,0.22)",
            borderRadius: 3,
            background: cell.point ? heatColor(cell.point.pct, maxAbs) : "rgba(26,24,20,0.04)",
          }}
        />
      ))}
    </div>
  );
}
