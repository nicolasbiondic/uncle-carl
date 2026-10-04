// ══════════════════════════════════════════════
// scripts/scorecard.ts — CLI del scorecard por sleeve/cuenta.
//
//   bun scripts/scorecard.ts [--db data/trading.db] [--hist data/historical.db] [--json]
//
// Lee AMBAS bases en READONLY (sirve contra un snapshot de prod copiado) y
// imprime, por entidad y ventana: retorno TW, CAGR, vol, Sharpe, Sortino,
// maxDD, benchmark en las mismas fechas, α/β OLS, IR, TE, PSR, utilización
// de capital y P&L realizado/no realizado — más la banda de expectativa
// bootstrap del artefacto OOS autoritativo (ver src/portfolio/scorecard.ts).
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import { computeScorecard, openHistoricalReadonly, type EntityScorecard, type ScorecardWindowMetrics } from "../src/portfolio/scorecard";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = arg("db", "data/trading.db");
const histPath = arg("hist", "data/historical.db");
const asJson = process.argv.includes("--json");

const db = new Database(dbPath, { readonly: true });
const hist = openHistoricalReadonly(histPath);

const sc = computeScorecard({ db, hist });

if (asJson) {
  console.log(JSON.stringify(sc, null, 2));
  process.exit(0);
}

const f = (x: number | null, d = 2, suffix = ""): string =>
  x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(d)}${suffix}`;
const money = (x: number | null): string => (x == null ? "—" : `$${x.toFixed(0)}`);

function windowRow(w: ScorecardWindowMetrics): string {
  return [
    w.window.padEnd(6),
    `${w.fromDate ?? "—"}→${w.toDate ?? "—"}`.padEnd(24),
    String(w.nObs).padStart(4),
    f(w.totalReturnPct, 2, "%").padStart(9),
    f(w.cagrPct, 1, "%").padStart(8),
    f(w.volAnnPct, 1, "%").padStart(7),
    f(w.sharpe).padStart(7),
    f(w.sortino).padStart(7),
    f(w.maxDrawdownPct, 2, "%").padStart(8),
    f(w.benchmark.totalReturnPct, 2, "%").padStart(9),
    f(w.alphaAnnPct, 1, "%").padStart(8),
    f(w.beta).padStart(6),
    f(w.informationRatio).padStart(6),
    f(w.trackingErrorAnnPct, 1, "%").padStart(7),
    f(w.psr == null ? null : w.psr * 100, 0, "%").padStart(5),
    f(w.capitalUtilizationPct, 0, "%").padStart(5),
    money(w.realizedPnl).padStart(9),
    money(w.unrealizedPnl).padStart(9),
  ].join(" ");
}

const HEADER = [
  "vent".padEnd(6), "rango".padEnd(24), "nObs".padStart(4), "retTW".padStart(9),
  "CAGR".padStart(8), "vol".padStart(7), "Sharpe".padStart(7), "Sortino".padStart(7),
  "maxDD".padStart(8), "bench".padStart(9), "αOLS/a".padStart(8), "β".padStart(6),
  "IR".padStart(6), "TE".padStart(7), "PSR".padStart(5), "util".padStart(5),
  "realiz".padStart(9), "noReal".padStart(9),
].join(" ");

function printEntity(e: EntityScorecard): void {
  console.log(`\n═══ ${e.label} (${e.id}) · grid ${e.grid} · benchmark ${e.benchmarkSymbol}${e.kind === "sleeve" ? ` · modelo desde ${e.modelStart}` : ""} ═══`);
  console.log(HEADER);
  for (const w of e.windows) console.log(windowRow(w));
  if (e.band) {
    const b = e.band;
    if (b.cumReturnPct) {
      console.log(
        `banda (h=${b.horizonSessions} sesiones, artefacto ${b.manifest}): ` +
        `ret p5/p50/p95 = ${f(b.cumReturnPct.p5, 2, "%")} / ${f(b.cumReturnPct.p50, 2, "%")} / ${f(b.cumReturnPct.p95, 2, "%")} · ` +
        `maxDD p5/p50/p95 = ${f(b.maxDDPct!.p5, 2, "%")} / ${f(b.maxDDPct!.p50, 2, "%")} / ${f(b.maxDDPct!.p95, 2, "%")} · ` +
        `vivo ret ${f(b.liveCumReturnPct, 2, "%")} / DD ${f(b.liveMaxDrawdownPct, 2, "%")} → ESTADO: ${b.status.toUpperCase()}`
      );
      if (b.selectionBias) {
        console.log(
          `  ajustada por sesgo de selección del universo: −${b.selectionBias.sharpeHaircut.toFixed(3)} de Sharpe ` +
          `(−${(b.selectionBias.dailyDrift * 100).toFixed(4)}%/sesión · ${b.selectionBias.evidence})`
        );
      }
    } else {
      console.log(`banda: ${b.status}${b.reason ? ` (${b.reason})` : ""}`);
    }
  }
}

console.log(`Scorecard · db=${dbPath} · hist=${histPath}${hist ? "" : " (NO DISPONIBLE — benchmarks vacíos)"} · generado ${new Date(sc.generatedAt).toISOString()}`);
for (const e of sc.entities) printEntity(e);
console.log("\nNotas:");
for (const n of sc.notes) console.log(` • ${n}`);
