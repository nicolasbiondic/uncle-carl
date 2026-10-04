#!/usr/bin/env bun
// ══════════════════════════════════════════════
// calibrate-costs.ts — coste REAL de ejecución por sleeve/lado vs el que
// asume el simulador (propuesta 6, docs/open-source-review-2026-09.md).
//
//   bun scripts/calibrate-costs.ts
//   bun scripts/calibrate-costs.ts --db data/trading.db --hist data/historical.db
//   bun scripts/calibrate-costs.ts --since 2026-09-10 --json
//
// SOLO LECTURA (ambas bases se abren readonly — sirve contra un snapshot de
// prod copiado). Toda la lógica vive en src/reports/costCalibration.ts (pura
// + readers readonly, testeada); este archivo es solo el CLI.
//
// Qué mide (detalle en el header del módulo):
//  • stocks diarios: fill vs OPEN del día de la decisión (drift + slippage,
//    la cuña sim↔vivo); momentum_stocks solo desde 2026-09-28 (kernel diario).
//  • crypto horario: fill vs open mainnet de la barra 1h del fill + comisión
//    real (trades) ÷ notional; periodos separados en 2026-09-10.
//  • stops: fill vs nivel del stop — el gap que el sim no cobra.
// Y compara con costs.base del manifest y el breakEvenCurve del artefacto
// vivo (interpolación lineal, sin extrapolar fuera de 0–30 bps).
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import {
  computeCostCalibration,
  type CostStats, type SleeveCostCalibration,
} from "../src/reports/costCalibration";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = arg("db", "data/trading.db");
const histPath = arg("hist", "data/historical.db");
const sinceArg = arg("since", "");
const asJson = process.argv.includes("--json");

let sinceMs: number | undefined;
if (sinceArg) {
  sinceMs = Date.parse(sinceArg);
  if (!Number.isFinite(sinceMs)) {
    console.error(`✗ --since "${sinceArg}" no es una fecha ISO parseable (p.ej. 2026-09-10)`);
    process.exit(1);
  }
}

function openReadonly(path: string, label: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (e: any) {
    console.error(`✗ No se pudo abrir ${label} en ${path}: ${e.message}`);
    process.exit(1);
    throw e; // unreachable
  }
}

const db = openReadonly(dbPath, "trading.db");
let hist: Database | null = null;
try { hist = new Database(histPath, { readonly: true }); } catch { hist = null; }

const cal = computeCostCalibration(db, hist, { sinceMs });

if (asJson) {
  console.log(JSON.stringify({ dbPath, histPath, sinceMs: sinceMs ?? null, ...cal }, null, 2));
  process.exit(0);
}

const f = (x: number | null | undefined, d = 1): string =>
  x == null || !Number.isFinite(x) ? "—" : x.toFixed(d);

function statsRow(label: string, s: CostStats | null): string[] {
  if (!s) return [label, "0", "—", "—", "—", "—"];
  const ci = s.ci95 ? `[${f(s.ci95.lo)}..${f(s.ci95.hi)}]` : "—";
  return [label, String(s.n), f(s.meanBps), f(s.medianBps), f(s.p90Bps), ci];
}

function printAligned(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log("  " + line(headers));
  console.log("  " + line(widths.map(w => "-".repeat(w))));
  for (const r of rows) console.log("  " + line(r));
}

function printSleeve(c: SleeveCostCalibration): void {
  console.log(`\n═══ ${c.sleeve} (${c.market})${c.comparableSinceEtDate ? ` · comparable desde ${c.comparableSinceEtDate}` : ""}${c.manifest ? ` · ${c.manifest}` : " · SIN artefacto autoritativo"} ═══`);
  const rows: string[][] = [];
  for (const p of c.periods) {
    rows.push(statsRow(`${p.period} · buy`, p.buy));
    rows.push(statsRow(`${p.period} · sell`, p.sell));
    rows.push(statsRow(`${p.period} · ambos`, p.combined));
    if (p.commissionPerSide) rows.push(statsRow(`${p.period} · comisión/lado`, p.commissionPerSide));
  }
  rows.push(statsRow("stops (vs nivel)", c.stops));
  printAligned(["serie", "n", "media", "mediana", "p90", "IC95(media)"], rows);
  const ex = c.excluded;
  console.log(`  excluidos: nonSim=${ex.nonSim} noBar=${ex.noBar} noStopLevel=${ex.noStopLevel} preModel=${ex.preModel}`);
  console.log(`  VEREDICTO: ${c.verdict}`);
}

console.log(`Calibración de costes · db=${dbPath} · hist=${histPath}${hist ? "" : " (NO DISPONIBLE — todo cae en noBar)"}${sinceMs ? ` · since=${new Date(sinceMs).toISOString()}` : ""}`);
console.log(`(bps positivos = coste; frontera de base de expected_px: ${cal.priceBasisBoundary} — la medida vs open no depende de expected_px, la partición separa eras)`);
for (const c of cal.sleeves) printSleeve(c);
