#!/usr/bin/env bun
/**
 * Self-contained HTML tearsheet for a walk-forward artifact (Lumibot/
 * NautilusTrader pattern — open-source review 2026-09 proposal 7).
 *
 *   bun scripts/tearsheet.ts <artifactDir> [--out <file>] [--hist <db>]
 *
 * Reads manifest-resolved.json + summary.json + runs.jsonl (outer base-tier
 * chain — scripts/lib/artifact.ts) and writes ONE offline HTML file:
 * inline SVG only, no CDN, no JS, no network. Content:
 *   - header: manifest, hashes, window, approval, chain purity
 *     (summary.outerSelection);
 *   - stitched OOS equity vs the manifest refSymbol's buy-and-hold
 *     (SPY for the stock sleeves, BTC for crypto), with the sequence-risk
 *     Monte Carlo band (scripts/lib/sequenceRisk.ts) underneath;
 *   - underwater (drawdown) curve;
 *   - monthly-return heatmap;
 *   - rolling 6-month Sharpe;
 *   - per-fold table (return / Sharpe / maxDD / trades / PSR / candidate);
 *   - acceptance-gate table (pass/fail);
 *   - sequence-risk Monte Carlo table (block bootstrap + trade reshuffle).
 *
 * Default output is <artifactDir>/tearsheet.html — the contract the
 * dashboard serves (file name fixed, artifact root). In THIS worktree the
 * artifact dirs are symlinks into the main checkout, so pass --out (e.g.
 * /tmp/opencode/uc/tearsheets/<hash8>.html); in prod run it without --out
 * (or copy the file into data/backtests/<hash>/tearsheet.html).
 *
 * The benchmark series needs bars (they are not stored in the artifact):
 * loaded from --hist, else the manifest's dbPath. Unavailable/missing bars
 * degrade to a note — the tearsheet still renders everything else.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadArtifact, type LoadedArtifact } from "./lib/artifact";
import {
  bootstrapEquityBand,
  computeSequenceRisk,
  type QuantileTriple,
  type SequenceRiskSummary,
} from "./lib/sequenceRisk";
import { loadBars, type ReplayResult } from "./backtest-momentum-wf";
import { periodsPerYear, stitchEquityHistory } from "./walk-forward";
import { getETDateKey } from "../src/db/database";

// ── data preparation ──────────────────────────────────────────────────

export interface DailyPoint {
  date: string;
  eq: number;
}

/** Last equity per day (ET-session key for RTH data, UTC otherwise) —
 *  the same bucketing walk-forward's stitchedDailyReturns uses. */
export function dailyEquitySeries(history: Array<{ t: number; eq: number }>, rthOnly: boolean): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (const pt of history) {
    const date = rthOnly ? getETDateKey(pt.t) : new Date(pt.t).toISOString().slice(0, 10);
    const cur = out[out.length - 1];
    if (cur && cur.date === date) cur.eq = pt.eq;
    else out.push({ date, eq: pt.eq });
  }
  return out;
}

export interface TearsheetData {
  artifactDir: string;
  manifest: LoadedArtifact["manifest"];
  summary: LoadedArtifact["summary"];
  outerResults: ReplayResult[];
  /** Normalized (start = 1) stitched daily equity. */
  daily: DailyPoint[];
  dailyRets: number[];
  /** Benchmark equity normalized to 1 at the strategy's first date, aligned
   *  to `daily` (carry-forward on holes); null when bars are unavailable. */
  bench: Array<number | null> | null;
  benchNote?: string;
  sequenceRisk: SequenceRiskSummary;
  /** Per-day bootstrap band aligned to daily[1..] (undefined on short series). */
  band?: QuantileTriple[];
  ppy: number;
}

export function buildTearsheetData(artifactDir: string, opts: { histDb?: string } = {}): TearsheetData {
  const { manifest, summary, outerResults } = loadArtifact(artifactDir);
  const rthOnly = outerResults[0]?.config?.rthOnly ?? false;
  const stitched = stitchEquityHistory(outerResults, manifest.ledger.initialEquity);
  const rawDaily = dailyEquitySeries(stitched, rthOnly);
  const e0 = rawDaily[0]?.eq || 1;
  const daily = rawDaily.map(d => ({ date: d.date, eq: d.eq / e0 }));
  const dailyRets: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    if (daily[i - 1].eq > 0) dailyRets.push((daily[i].eq - daily[i - 1].eq) / daily[i - 1].eq);
  }

  // Benchmark: refSymbol bars over the SAME outer fold windows, stitched
  // like the strategy (fold returns compound in fold order).
  let bench: Array<number | null> | null = null;
  let benchNote: string | undefined;
  const dbPath = opts.histDb ?? manifest.data.dbPath;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const pseudo = outerResults.map(r => {
        const bars = loadBars(manifest.data.refSymbol, manifest.data.timeframe, manifest.data.source, manifest.data.rthOnly, r.fromMs, r.toMs, db);
        if (bars.length < 2) throw new Error(`fewer than 2 ${manifest.data.refSymbol} bars in ${r.window.label}`);
        return {
          fromMs: r.fromMs,
          equityHistory: bars.map(b => ({ t: b.timestamp, eq: b.close })),
        } as unknown as ReplayResult;
      });
      const benchDaily = dailyEquitySeries(stitchEquityHistory(pseudo, 1), rthOnly);
      const byDate = new Map(benchDaily.map(d => [d.date, d.eq]));
      let last: number | null = null;
      let first: number | null = null;
      bench = daily.map(d => {
        const v = byDate.get(d.date);
        if (v !== undefined) last = v;
        if (last !== null && first === null) first = last;
        return last !== null && first !== null ? last / first : null;
      });
    } finally {
      db.close();
    }
  } catch (e) {
    bench = null;
    benchNote = `benchmark unavailable: ${(e as Error).message}`;
  }

  const pnls = outerResults.flatMap(r => r.closedTrades).sort((a, b) => a.exitAt - b.exitAt).map(t => t.pnl);
  const sequenceRisk = computeSequenceRisk(dailyRets, pnls, manifest.ledger.initialEquity);
  const band = bootstrapEquityBand(dailyRets);
  return {
    artifactDir,
    manifest,
    summary,
    outerResults,
    daily,
    dailyRets,
    bench,
    benchNote,
    sequenceRisk,
    band,
    ppy: periodsPerYear(manifest.sleeve, manifest.data.source),
  };
}

// ── SVG helpers (no external deps, no JS) ─────────────────────────────

const W = 880, H = 260, PADL = 56, PADR = 12, PADT = 14, PADB = 26;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Line {
  name: string;
  color: string;
  dash?: string;
  values: Array<number | null>;
}

function lineChartSvg(
  labels: string[],
  lines: Line[],
  opts: { yFmt?: (v: number) => string; band?: { lo: Array<number | null>; hi: Array<number | null>; color: string; name: string }; fillTo0?: string; yZeroLine?: boolean } = {},
): string {
  const yFmt = opts.yFmt ?? ((v: number) => v.toFixed(2));
  const all: number[] = [];
  for (const l of lines) for (const v of l.values) if (v !== null && Number.isFinite(v)) all.push(v);
  if (opts.band) for (const v of [...opts.band.lo, ...opts.band.hi]) if (v !== null && Number.isFinite(v)) all.push(v);
  if (all.length === 0) return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><text x="20" y="30">no data</text></svg>`;
  let yMin = Math.min(...all), yMax = Math.max(...all);
  if (opts.yZeroLine) { yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0); }
  if (yMax === yMin) { yMax += 1; yMin -= 1; }
  const n = labels.length;
  const x = (i: number) => PADL + (i / Math.max(1, n - 1)) * (W - PADL - PADR);
  const y = (v: number) => PADT + ((yMax - v) / (yMax - yMin)) * (H - PADT - PADB);

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" font-size="11">`);
  // y grid (5 lines)
  for (let g = 0; g <= 4; g++) {
    const v = yMin + ((yMax - yMin) * g) / 4;
    parts.push(`<line x1="${PADL}" y1="${y(v).toFixed(1)}" x2="${W - PADR}" y2="${y(v).toFixed(1)}" stroke="#e3e3e8" stroke-width="1"/>`);
    parts.push(`<text x="${PADL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="#666">${esc(yFmt(v))}</text>`);
  }
  if (opts.yZeroLine && yMin < 0 && yMax > 0) {
    parts.push(`<line x1="${PADL}" y1="${y(0).toFixed(1)}" x2="${W - PADR}" y2="${y(0).toFixed(1)}" stroke="#999" stroke-width="1"/>`);
  }
  // x labels (~6 ticks)
  const ticks = Math.min(6, n);
  for (let t = 0; t < ticks; t++) {
    const i = Math.round((t / Math.max(1, ticks - 1)) * (n - 1));
    parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#666">${esc(labels[i] ?? "")}</text>`);
  }
  const toPath = (values: Array<number | null>) => {
    let d = "", pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  if (opts.band) {
    const { lo, hi, color } = opts.band;
    let fwd = "", back = "";
    for (let i = 0; i < n; i++) {
      const l = lo[i], h = hi[i];
      if (l === null || h === null) continue;
      fwd += `${fwd ? "L" : "M"}${x(i).toFixed(1)},${y(h).toFixed(1)}`;
      back = `L${x(i).toFixed(1)},${y(l).toFixed(1)}` + back;
    }
    if (fwd) parts.push(`<path d="${fwd}${back}Z" fill="${color}" stroke="none"/>`);
  }
  if (opts.fillTo0) {
    const v0 = lines[0].values;
    let fwd = "";
    for (let i = 0; i < n; i++) {
      const v = v0[i];
      if (v === null || !Number.isFinite(v)) continue;
      fwd += `${fwd ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    if (fwd) parts.push(`<path d="${fwd}L${x(n - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z" fill="${opts.fillTo0}" stroke="none"/>`);
  }
  for (const l of lines) {
    parts.push(`<path d="${toPath(l.values)}" fill="none" stroke="${l.color}" stroke-width="1.6"${l.dash ? ` stroke-dasharray="${l.dash}"` : ""}/>`);
  }
  // legend
  let lx = PADL + 6;
  const legend: Array<{ name: string; color: string }> = [
    ...(opts.band ? [{ name: opts.band.name, color: opts.band.color }] : []),
    ...lines.map(l => ({ name: l.name, color: l.color })),
  ];
  for (const l of legend) {
    parts.push(`<rect x="${lx}" y="${PADT}" width="10" height="10" fill="${l.color}"/><text x="${lx + 14}" y="${PADT + 9}" fill="#333">${esc(l.name)}</text>`);
    lx += 14 + l.name.length * 6 + 18;
  }
  parts.push("</svg>");
  return parts.join("");
}

function monthlyHeatmapHtml(daily: DailyPoint[]): string {
  // Compound daily equity into per-month returns.
  const byMonth = new Map<string, { first: number; last: number }>();
  for (let i = 1; i < daily.length; i++) {
    const m = daily[i].date.slice(0, 7);
    const cur = byMonth.get(m);
    if (cur) cur.last = daily[i].eq;
    else byMonth.set(m, { first: daily[i - 1].eq, last: daily[i].eq });
  }
  const years = [...new Set([...byMonth.keys()].map(k => k.slice(0, 4)))].sort();
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const cell = (r: number | undefined) => {
    if (r === undefined) return `<td class="mh"></td>`;
    const alpha = Math.min(1, Math.abs(r) / 0.1).toFixed(2);
    const bg = r >= 0 ? `rgba(22,142,84,${alpha})` : `rgba(204,51,51,${alpha})`;
    return `<td class="mh" style="background:${bg}">${(r * 100).toFixed(1)}</td>`;
  };
  const rows = years.map(yr => {
    let yearEq = 1;
    const tds = months.map(mm => {
      const v = byMonth.get(`${yr}-${mm}`);
      const r = v && v.first > 0 ? v.last / v.first - 1 : undefined;
      if (r !== undefined) yearEq *= 1 + r;
      return cell(r);
    }).join("");
    return `<tr><th>${yr}</th>${tds}${cell(yearEq - 1)}</tr>`;
  }).join("");
  return `<table class="heat"><thead><tr><th></th>${months.map(m => `<th>${m}</th>`).join("")}<th>YR</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rollingSharpe(dailyRets: number[], window: number, ppy: number): Array<number | null> {
  const out: Array<number | null> = new Array(dailyRets.length).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < dailyRets.length; i++) {
    sum += dailyRets[i];
    sumSq += dailyRets[i] ** 2;
    if (i >= window) {
      sum -= dailyRets[i - window];
      sumSq -= dailyRets[i - window] ** 2;
    }
    if (i >= window - 1) {
      const mean = sum / window;
      const varc = Math.max(0, (sumSq - window * mean * mean) / (window - 1));
      const sd = Math.sqrt(varc);
      out[i] = sd > 0 ? (mean / sd) * Math.sqrt(ppy) : 0;
    }
  }
  return out;
}

// ── HTML assembly ─────────────────────────────────────────────────────

const pct = (x: number | undefined | null, digits = 1) =>
  x === undefined || x === null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)}%`;
const num = (x: number | undefined | null, digits = 2) =>
  x === undefined || x === null || !Number.isFinite(x) ? "—" : x.toFixed(digits);

export function renderTearsheetHtml(d: TearsheetData): string {
  const { manifest: m, summary: s } = d;
  const labels = d.daily.map(x => x.date);
  const chainHashes = new Set((s.outerSelection ?? []).map(c => c.candidateHash));
  const purity = (s.outerSelection?.length ?? 0) === 0
    ? "unknown (summary predates outerSelection)"
    : chainHashes.size === 1
      ? `PURE — every outer fold ran ${s.outerSelection![0].candidateName}`
      : `MIXED — ${s.outerSelection!.map(c => `${c.foldPath}=${c.candidateName}`).join(", ")}`;

  // Equity chart with MC band (band is indexed on dailyRets = daily[1..]).
  const eqValues = d.daily.map(x => x.eq);
  const bandLo: Array<number | null> = [1, ...(d.band?.map(b => b.p5) ?? [])];
  const bandHi: Array<number | null> = [1, ...(d.band?.map(b => b.p95) ?? [])];
  while (bandLo.length < labels.length) { bandLo.push(null); bandHi.push(null); }
  const equitySvg = lineChartSvg(labels, [
    { name: `strategy (stitched OOS)`, color: "#1459c7", values: eqValues },
    ...(d.bench ? [{ name: `${m.data.refSymbol} buy&hold`, color: "#c78214", values: d.bench }] : []),
  ], {
    yFmt: v => `${v.toFixed(1)}×`,
    ...(d.band ? { band: { lo: bandLo, hi: bandHi, color: "rgba(20,89,199,0.13)", name: "MC p5–p95 (block bootstrap)" } } : {}),
  });

  // Underwater.
  let peak = 0;
  const dd = d.daily.map(x => {
    peak = Math.max(peak, x.eq);
    return peak > 0 ? -(peak - x.eq) / peak : 0;
  });
  const ddSvg = lineChartSvg(labels, [{ name: "drawdown", color: "#b32424", values: dd }], {
    yFmt: v => pct(v, 0),
    fillTo0: "rgba(179,36,36,0.25)",
    yZeroLine: true,
  });

  // Rolling 6m Sharpe.
  const win = Math.round(d.ppy / 2);
  const rs = rollingSharpe(d.dailyRets, win, d.ppy);
  const rsSvg = lineChartSvg(labels.slice(1), [{ name: `rolling ${win}d Sharpe`, color: "#0e7d6b", values: rs }], {
    yFmt: v => v.toFixed(1),
    yZeroLine: true,
  });

  const selByFold = new Map((s.outerSelection ?? []).map(c => [c.foldPath, c.candidateName]));
  const psrByFold = new Map((s.foldPsr ?? []).map(f => [f.foldPath, f.psr]));
  const foldRows = d.outerResults.map(r => {
    const label = r.window.label;
    return `<tr><td>${esc(label)}</td><td>${esc(selByFold.get(label) ?? "—")}</td><td>${r.window.from.slice(0, 10)} → ${r.window.to.slice(0, 10)}</td><td class="r">${pct(r.totalReturn)}</td><td class="r">${num(r.sharpe)}</td><td class="r">${pct(r.maxDrawdown)}</td><td class="r">${r.trades}</td><td class="r">${num(psrByFold.get(label), 3)}</td></tr>`;
  }).join("");

  const gateRows = Object.values(s.acceptance ?? {}).map(g =>
    `<tr class="${g.pass ? "pass" : "fail"}"><td>${esc(g.gate)}</td><td class="r">${num(g.value, 4)}</td><td class="r">${num(g.threshold, 4)}</td><td>${g.pass ? "✓ pass" : "✗ FAIL"}</td><td>${esc(g.reason ?? "")}</td></tr>`,
  ).join("");

  const b = d.sequenceRisk.bootstrap;
  const r = d.sequenceRisk.tradeReshuffle;
  const mcRows = [
    b ? `<tr><td>block bootstrap (${b.blockSize}d × ${b.paths} paths, seed ${b.seed})</td><td class="r">${pct(b.maxDrawdown.p5)}</td><td class="r">${pct(b.maxDrawdown.p50)}</td><td class="r">${pct(b.maxDrawdown.p95)}</td><td class="r">${pct(b.observedMaxDrawdown)}</td><td class="r">${pct(b.observedMaxDdPercentile)}</td><td class="r">${pct(b.finalReturn.p5)} / ${pct(b.finalReturn.p50)} / ${pct(b.finalReturn.p95)}</td></tr>` : "",
    r ? `<tr><td>trade reshuffle (${r.trades} trades × ${r.paths} paths)</td><td class="r">${pct(r.maxDrawdown.p5)}</td><td class="r">${pct(r.maxDrawdown.p50)}</td><td class="r">${pct(r.maxDrawdown.p95)}</td><td class="r">${pct(r.observedMaxDrawdown)}</td><td class="r">${pct(r.observedMaxDdPercentile)}</td><td class="r">${pct(r.finalReturn)} (invariant)</td></tr>` : "",
  ].join("");

  const oos = s.stitchedOos;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Tearsheet — ${esc(m.name)} (${esc(s.manifestHash.slice(0, 8))})</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1c1c22;background:#fff}
h1{font-size:20px;margin-bottom:2px} h2{font-size:15px;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:3px}
table{border-collapse:collapse;font-size:12px;width:100%} td,th{padding:3px 8px;border:1px solid #e2e2e8;text-align:left}
td.r{text-align:right;font-variant-numeric:tabular-nums}
tr.pass td{background:#f0faf3} tr.fail td{background:#fbeeee}
table.heat td.mh{text-align:right;font-variant-numeric:tabular-nums;min-width:38px}
.meta{font-size:12px;color:#444;line-height:1.6} .meta code{background:#f4f4f7;padding:1px 4px;border-radius:3px}
.kpis{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0} .kpi{background:#f6f7fa;border-radius:6px;padding:8px 14px}
.kpi b{display:block;font-size:16px} .kpi span{font-size:11px;color:#666}
.note{font-size:11px;color:#886}
svg{width:100%;height:auto;display:block;margin:4px 0 2px}
</style></head><body>
<h1>${esc(m.name)}</h1>
<div class="meta">
sleeve <code>${esc(m.sleeve)}</code> · source <code>${esc(m.data.source)}/${esc(m.data.timeframe)}</code> · benchmark <code>${esc(m.data.refSymbol)}</code> · window ${esc(m.window.from)} → ${esc(m.window.to)} (resolved to ${esc(s.resolvedTo.slice(0, 10))}) · ${m.window.outerFoldCount}×${m.window.innerFoldCount} folds, purge ${m.window.purgeYears}y, warm-up ${m.window.warmupDays}d<br>
manifest <code>${esc(s.manifestHash)}</code><br>
config <code>${esc(s.configHash.slice(0, 16))}…</code> · data <code>${esc(s.dataHash.slice(0, 16))}…</code> · code <code>${esc(s.codeHash.slice(0, 16))}…</code><br>
chain: <b>${esc(purity)}</b><br>
approved: <b>${s.approved ? "yes" : "no"}</b> — ${esc(s.approvalReason)}
</div>
<div class="kpis">
<div class="kpi"><b>${pct(oos.totalReturn)}</b><span>stitched OOS return${oos.benchReturn !== undefined ? ` (bench ${pct(oos.benchReturn)})` : ""}</span></div>
<div class="kpi"><b>${num(oos.sharpe)}</b><span>Sharpe${oos.benchSharpe !== undefined ? ` (bench ${num(oos.benchSharpe)})` : ""}</span></div>
<div class="kpi"><b>${pct(oos.maxDrawdown)}</b><span>max drawdown</span></div>
<div class="kpi"><b>${oos.trades}</b><span>trades · win ${pct(oos.winRate, 0)}</span></div>
<div class="kpi"><b>${num(s.outerPsr, 3)}</b><span>outer PSR · ${s.observations ?? "—"} obs</span></div>
</div>
<h2>Equity — stitched OOS vs ${esc(m.data.refSymbol)} buy &amp; hold, with Monte Carlo band</h2>
${equitySvg}
${d.benchNote ? `<div class="note">${esc(d.benchNote)}</div>` : ""}
<h2>Underwater (drawdown)</h2>
${ddSvg}
<h2>Monthly returns (%)</h2>
${monthlyHeatmapHtml(d.daily)}
<h2>Rolling 6-month Sharpe</h2>
${rsSvg}
<h2>Per-fold OOS results (base tier)</h2>
<table><thead><tr><th>fold</th><th>candidate</th><th>window</th><th>return</th><th>Sharpe</th><th>maxDD</th><th>trades</th><th>PSR</th></tr></thead><tbody>${foldRows}</tbody></table>
<h2>Acceptance gates</h2>
<table><thead><tr><th>gate</th><th>value</th><th>threshold</th><th>verdict</th><th>note</th></tr></thead><tbody>${gateRows}</tbody></table>
<h2>Sequence-risk Monte Carlo (maxDD distribution)</h2>
<table><thead><tr><th>method</th><th>p5</th><th>p50</th><th>p95</th><th>observed</th><th>obs. percentile</th><th>final return p5/p50/p95</th></tr></thead><tbody>${mcRows || `<tr><td colspan="7">not computable (series too short)</td></tr>`}</tbody></table>
<div class="note">Generated offline from ${esc(d.artifactDir)} — no external resources. Observed-DD percentile ≈ 1.0 means the realized ordering was worse than nearly every simulated reordering (sequence anomaly, Jesse pattern). The trade reshuffle assumes exchangeable trades; sleeves whose losses cluster by construction (e.g. correlated dip-buying) legitimately sit high on it — read it against the block bootstrap, which preserves ${d.sequenceRisk.bootstrap?.blockSize ?? 10}-day clustering.</div>
</body></html>`;
}

export function generateTearsheet(artifactDir: string, opts: { histDb?: string; out?: string } = {}): { outPath: string; html: string } {
  const data = buildTearsheetData(artifactDir, opts);
  const html = renderTearsheetHtml(data);
  const outPath = opts.out ?? join(artifactDir, "tearsheet.html");
  writeFileSync(outPath, html);
  return { outPath, html };
}

// ── CLI ───────────────────────────────────────────────────────────────

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const flagsWithValue = new Set(["--out", "--hist"]);
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.has(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    dir = args[i];
    break;
  }
  if (!dir) {
    console.error("Usage: bun scripts/tearsheet.ts <artifactDir> [--out <file>] [--hist <db>]");
    process.exit(2);
  }
  const { outPath, html } = generateTearsheet(dir, { histDb: argOf("--hist"), out: argOf("--out") });
  console.log(`tearsheet written: ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
}

if (import.meta.main) await main();
