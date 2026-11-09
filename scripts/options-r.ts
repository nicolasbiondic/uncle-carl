#!/usr/bin/env bun
/**
 * Vega phase R (quorum Q9): runs the three frozen candidates of experiments/options-vega-r-v1.json and
 * evaluates the frozen acceptance. Nothing here is a parameter: every number comes from the manifest,
 * the results-blind audit (hist-options-audit.json) or the data.
 *
 *   primary   each candidate on the mirror over its primary window (windows.primary, from the audit)
 *   early     the weeks before it (informative)
 *   overlap   entries 2024-02-02 → last exit inside the mirror: mirror AND second provider (3a)
 *   holdout   entries after the mirror → last exit <= 2026-11-06: second provider only (3b)
 *   variants  fractional contracts · T-bill collateral (FRED DTB3) · regime read at the entry close ·
 *             costs ×2 · liquidation-marked drawdown · QQQ benchmark (O3) · WPUT correlation (O1) ·
 *             halves · PSR/MinTRL · short-call-over-ex-dividend count · cash weeks by reason
 *
 * Writes data/backtests/<sha256(canonical manifest + data hashes + code version)>/ with
 * manifest-resolved.json, summary.json, weekly-<candidate>-<run>.jsonl and audit.json.
 *
 * Usage: bun run scripts/options-r.ts [--out data/backtests] [--no-fetch]   (--no-fetch skips FRED/Cboe)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { expandDataPath } from "./lib/researchData";
import {
  BOOTSTRAP, bsDelta, buildWeeks, calendarDays, candidateUnderlying, circularBlockBootstrap, eligibleExpiration, holm, impliedVol,
  maTrendRiskOff, maxDrawdown, psrAndMinTrl, sessionsBetween, simulateWeek, type CandidateName, type Costs, type Expiry, type Quote, type Session,
  type Week, type WeekResult, COSTS,
} from "./lib/optionsWeekly";
import {
  alpacaChainCloses, alpacaDividends, alpacaListed, alpacaRawCloses, alpacaTablesHash, buildSessions, historicalAdjustedCloses, mirrorChain,
  mirrorLastOptionsDate, mirrorListed, mirrorUnderlying, openOptionsDb, spliceAdjusted, UNDERLYINGS,
} from "./lib/optionsData";

export const ROOT = join(import.meta.dir, "..");
export const MANIFEST_PATH = join(ROOT, "experiments/options-vega-r-v1.json");
const CANDIDATES: CandidateName[] = ["O1-put-writer", "O2-credit-spread", "O3-convex-buyer"];
const HOLM_ALPHA = 0.10;
const HOLDOUT_CAP = "2026-11-06";

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(obj as object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((obj as any)[k])}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── data context ─────────────────────────────────────────────────────────────────────────────────

export interface Context {
  sessions: Session[];
  weeks: Week[];
  adj: Record<string, Map<Session, number>>;
  raw: Record<string, Map<Session, number>>;
  exDividends: Record<string, Set<Session>>;
  mirrorLast: Record<string, string>;
  /** riskOff at the close of every session (index = sessions index) */
  riskOff: boolean[];
  listed: (underlying: string, entry: Session) => string[];
  mirrorChain: (u: string, date: Session, exp: string) => Quote[];
  alpacaChain: (u: string, date: Session, expiry: Expiry) => Quote[];
  alpacaClampedDeltas: { count: number };
  hTable: Record<string, number>;
  audit: any;
}

const DELTA_BUCKETS: Array<[number, number]> = [[0, 0.15], [0.15, 0.35], [0.35, 0.65]];
/** h keyed "<underlying>|<type>|<bucket index>", built from the audit cells' numeric absDeltaBucket (never from their string keys:
 *  run 1, 23f5bc9c…, matched "0-0.15" against the audit's "0.0-0.15" and treated every |delta| < 0.15 Alpaca quote as missing). */
export function hTableFromAudit(cells: Record<string, { underlying: string; type: string; absDeltaBucket: [number, number]; h: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of Object.values(cells)) {
    const i = DELTA_BUCKETS.findIndex(([lo, hi]) => Math.abs(lo - c.absDeltaBucket[0]) < 1e-9 && Math.abs(hi - c.absDeltaBucket[1]) < 1e-9);
    if (i < 0) throw new Error(`audit bucket ${JSON.stringify(c.absDeltaBucket)} is not a frozen bucket`);
    out[`${c.underlying}|${c.type}|${i}`] = c.h;
  }
  return out;
}
export function hFor(hTable: Record<string, number>, underlying: string, type: string, absDelta: number, clamped?: { count: number }): number | undefined {
  let i = DELTA_BUCKETS.findIndex(([lo, hi]) => absDelta >= lo && (absDelta < hi || (hi === 0.65 && absDelta === hi)));
  if (i < 0) { i = DELTA_BUCKETS.length - 1; if (clamped) clamped.count++; }
  return hTable[`${underlying}|${type}|${i}`];
}

export function loadContext(db: Database, audit: any): Context {
  const mirror = Object.fromEntries(UNDERLYINGS.map(u => [u, mirrorUnderlying(db, u)]));
  const historical = Object.fromEntries(UNDERLYINGS.map(u => [u, historicalAdjustedCloses(join(ROOT, "data/historical.db"), u)]));
  const sessions = buildSessions(mirror.SPY, historical.SPY);
  const adj = Object.fromEntries(UNDERLYINGS.map(u => [u, spliceAdjusted(mirror[u], historical[u])]));
  const raw: Record<string, Map<Session, number>> = {};
  const exDividends: Record<string, Set<Session>> = {};
  for (const u of UNDERLYINGS) {
    const m = new Map<Session, number>(mirror[u].map(r => [r.date, r.close]));
    const lastMirror = mirror[u][mirror[u].length - 1].date;
    for (const [d, c] of alpacaRawCloses(db, u)) if (d > lastMirror) m.set(d, c);
    raw[u] = m;
    const ex = new Set<Session>(mirror[u].filter(r => r.dividend_amount > 0).map(r => r.date));
    for (const [d] of alpacaDividends(db, u)) if (d > lastMirror) ex.add(d);
    exDividends[u] = ex;
  }
  const mirrorLast = Object.fromEntries(UNDERLYINGS.map(u => [u, mirrorLastOptionsDate(db, u)]));
  const spyCloses = sessions.map(s => adj.SPY.get(s)).filter((x): x is number => x !== undefined);
  if (spyCloses.length !== sessions.length) throw new Error("adjusted SPY close missing for a session");
  const riskOff = maTrendRiskOff(spyCloses);
  const hTable = hTableFromAudit(audit.spreadModel.cells);
  if (Object.keys(hTable).length !== UNDERLYINGS.length * 2 * DELTA_BUCKETS.length) throw new Error(`incomplete h table: ${Object.keys(hTable).join(", ")}`);
  const clamped = { count: 0 };
  const listedCache = new Map<string, string[]>();
  return {
    sessions, weeks: buildWeeks(sessions), adj, raw, exDividends, mirrorLast, riskOff, hTable, audit, alpacaClampedDeltas: clamped,
    listed: (u, entry) => {
      const k = `${u}|${entry}`;
      let v = listedCache.get(k);
      if (!v) { v = entry <= mirrorLast[u] ? mirrorListed(db, u, entry) : alpacaListed(db, u, entry); listedCache.set(k, v); }
      return v;
    },
    mirrorChain: (u, date, exp) => mirrorChain(db, u, date, exp),
    alpacaChain: (u, date, expiry) => {
      const S = raw[u].get(date);
      if (S === undefined) return [];
      const T = calendarDays(date, expiry.expirationSession) / 365;
      const out: Quote[] = [];
      for (const b of alpacaChainCloses(db, u, date, expiry.expiration)) {
        if (!(b.close > 0)) continue;
        // the bar close plays the mid: IV and delta from it (the frozen rule), h by |delta| bucket
        const iv = impliedVol(S, b.strike, T, b.close, b.type);
        if (iv === null) { out.push({ type: b.type, strike: b.strike, bid: null, ask: null }); continue; }
        const h = hFor(hTable, u, b.type, Math.abs(bsDelta(S, b.strike, T, iv, b.type)), clamped);
        if (h === undefined) { out.push({ type: b.type, strike: b.strike, bid: null, ask: null }); continue; }
        out.push({ type: b.type, strike: b.strike, bid: b.close * (1 - h), ask: b.close * (1 + h), synthetic: true });
      }
      return out;
    },
  };
}

// ── one run ──────────────────────────────────────────────────────────────────────────────────────

export interface RunOptions { provider: "mirror" | "alpaca"; signalAtEntry?: boolean; fractional?: boolean; costs?: Costs }

export interface WeekRow extends WeekResult {
  /** candidate weekly return entry → next entry (cash after exit) */
  r: number;
  /** SPY total return entry → next entry, null when the next entry's close is unknown */
  rSpy: number | null;
  rQqq: number | null;
  x: number | null;
  nextEntry: Session | null;
  holdSessions: number;
}

export function runCandidate(ctx: Context, candidate: CandidateName, weeks: readonly Week[], o: RunOptions, capital: number): WeekRow[] {
  let equity = capital;
  const rows: WeekRow[] = [];
  for (const w of weeks) {
    const iSignal = ctx.sessions.indexOf(o.signalAtEntry ? w.entry : w.signal);
    const riskOff = ctx.riskOff[iSignal];
    const u = candidateUnderlying(candidate, riskOff);
    const expiry = eligibleExpiration(ctx.sessions, w.entry, ctx.listed(u, w.entry));
    const i0 = ctx.sessions.indexOf(w.entry);
    const hold = expiry ? ctx.sessions.slice(i0, ctx.sessions.indexOf(expiry.exit) + 1) : [w.entry];
    const res = simulateWeek({
      candidate, week: w, expiry, riskOff, equity, costs: o.costs, fractional: o.fractional,
      rawClose: (uu, s) => ctx.raw[uu].get(s),
      chain: o.provider === "mirror" ? (uu, s, e) => ctx.mirrorChain(uu, s, e) : (uu, s) => ctx.alpacaChain(uu, s, expiry!),
    }, hold);
    const next = ctx.weeks[ctx.weeks.indexOf(w) + 1];
    const a0 = ctx.adj.SPY.get(w.entry)!, a1 = next ? ctx.adj.SPY.get(next.entry) : undefined;
    const q0 = ctx.adj.QQQ.get(w.entry), q1 = next ? ctx.adj.QQQ.get(next.entry) : undefined;
    const r = res.equityExit / res.equityEntry - 1;
    const rSpy = a1 !== undefined ? a1 / a0 - 1 : null;
    const rQqq = q0 !== undefined && q1 !== undefined ? q1 / q0 - 1 : null;
    let shortCallItmOverExDividend: boolean | undefined;
    if (res.status === "traded" && res.legs.some(l => l.side === "short" && l.type === "call")) {
      const k = res.legs.find(l => l.side === "short" && l.type === "call")!.strike;
      shortCallItmOverExDividend = hold.slice(1).some(s => ctx.exDividends[u].has(s) && (ctx.raw[u].get(ctx.sessions[ctx.sessions.indexOf(s) - 1]) ?? 0) > k);
    }
    rows.push({ ...res, shortCallItmOverExDividend, r, rSpy, rQqq, x: rSpy === null ? null : Math.log(1 + r) - Math.log(1 + rSpy), nextEntry: next?.entry ?? null, holdSessions: expiry ? sessionsBetween(ctx.sessions, w.entry, expiry.exit) : 0 });
    equity = res.equityExit;
  }
  return rows;
}

/** Daily equity over every session from the first entry to the last exit (carry forward on uncovered sessions). */
export function dailyCurve(ctx: Context, rows: readonly WeekRow[], key: "dailyMid" | "dailyLiquidation"): Array<{ session: Session; equity: number }> {
  if (!rows.length) return [];
  const marks = new Map<Session, number>();
  for (const r of rows) for (const d of r[key]) marks.set(d.session, d.equity);
  const first = rows[0].entry, last = rows[rows.length - 1].exit ?? rows[rows.length - 1].entry;
  const out: Array<{ session: Session; equity: number }> = [];
  let eq = rows[0].equityEntry;
  for (const s of ctx.sessions) {
    if (s < first || s > last) continue;
    eq = marks.get(s) ?? eq;
    out.push({ session: s, equity: eq });
  }
  return out;
}

export interface RunStats {
  weeks: number; traded: number; cash: number; cashByReason: Record<string, number>;
  from: Session; to: Session | null; calendarDays: number;
  equityStart: number; equityEnd: number; cagr: number; spyCagr: number | null;
  meanX: number | null; pairedWeeks: number; meanR: number; meanRSpy: number | null;
  maxDrawdownMid: number; maxDrawdownLiquidation: number;
  worstWeekPct: number | null; worstWeekPctO2O3Rule: boolean | null;
  ordersPerWeek: number; missingQuotesAtExit: number; intrinsicMarks: number; maxHoldSessions: number; anyLegIntoExpiration: boolean;
  shortCallOverExDividendWeeks: number; contractsMean: number | null;
}

export function runStats(ctx: Context, rows: readonly WeekRow[], candidate: CandidateName): RunStats | null {
  if (!rows.length) return null;
  const traded = rows.filter(r => r.status === "traded");
  const cashByReason: Record<string, number> = {};
  for (const r of rows) if (r.status === "cash") cashByReason[r.reason!] = (cashByReason[r.reason!] ?? 0) + 1;
  const paired = rows.filter(r => r.x !== null);
  const last = rows[rows.length - 1];
  const to = last.nextEntry ?? last.exit ?? last.entry;
  const days = calendarDays(rows[0].entry, to);
  const eqEnd = last.equityExit;
  const spy0 = ctx.adj.SPY.get(rows[0].entry)!, spy1 = ctx.adj.SPY.get(to);
  const mid = dailyCurve(ctx, rows, "dailyMid"), liq = dailyCurve(ctx, rows, "dailyLiquidation");
  const worst = traded.length ? Math.min(...traded.map(r => r.pnl / r.equityEntry)) : null;
  const worstCheck = candidate === "O1-put-writer" ? null : worst === null ? true : worst >= -0.02 - 1e-12;
  return {
    weeks: rows.length, traded: traded.length, cash: rows.length - traded.length, cashByReason,
    from: rows[0].entry, to, calendarDays: days,
    equityStart: rows[0].equityEntry, equityEnd: eqEnd, cagr: (eqEnd / rows[0].equityEntry) ** (365 / days) - 1,
    spyCagr: spy1 !== undefined ? (spy1 / spy0) ** (365 / days) - 1 : null,
    meanX: paired.length ? paired.reduce((a, r) => a + r.x!, 0) / paired.length : null, pairedWeeks: paired.length,
    meanR: rows.reduce((a, r) => a + r.r, 0) / rows.length,
    meanRSpy: paired.length ? paired.reduce((a, r) => a + r.rSpy!, 0) / paired.length : null,
    maxDrawdownMid: maxDrawdown(mid.map(d => d.equity)), maxDrawdownLiquidation: maxDrawdown(liq.map(d => d.equity)),
    worstWeekPct: worst, worstWeekPctO2O3Rule: worstCheck,
    ordersPerWeek: rows.reduce((a, r) => a + r.orders, 0) / rows.length,
    missingQuotesAtExit: rows.reduce((a, r) => a + r.missingQuoteAtExit, 0), intrinsicMarks: rows.reduce((a, r) => a + r.intrinsicMarks, 0),
    maxHoldSessions: Math.max(0, ...rows.map(r => r.holdSessions)),
    anyLegIntoExpiration: rows.some(r => r.status === "traded" && (r.holdSessions > 4 || r.exit === null)),
    shortCallOverExDividendWeeks: rows.filter(r => r.shortCallItmOverExDividend).length,
    contractsMean: traded.length ? traded.reduce((a, r) => a + r.contracts, 0) / traded.length : null,
  };
}

// ── acceptance ───────────────────────────────────────────────────────────────────────────────────

export interface CandidateEvaluation {
  candidate: CandidateName;
  window: { primaryStart: Session; primaryEnd: Session; overlapStart: Session; overlapEnd: Session; holdoutStart: Session | null; holdoutEnd: Session | null };
  primary: RunStats; bootstrap: ReturnType<typeof circularBlockBootstrap>;
  overlapMirror: RunStats | null; overlapAlpaca: RunStats | null; overlapCorrelation: number | null;
  holdout: RunStats | null; holdoutBootstrap: ReturnType<typeof circularBlockBootstrap> | null;
  criteria: { "1_pairedExcess": boolean; "2_drawdown": boolean; "3a_overlapConsistency": boolean | null; "3b_holdout": boolean | null; "4_rules": boolean };
  holmRejected: boolean;
  pass: boolean;
}

export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n, mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** The acceptance's pure part, testable on synthetic fixtures: criteria 1 (before Holm), 2, 3a, 3b, 4 and the PASS. */
export function evaluateCriteria(e: { bootstrap: { p: number; mean: number }; maxDrawdownMid: number; overlapMeanMirror: number | null; overlapMeanAlpaca: number | null; holdoutMean: number | null; rules: { anyLegIntoExpiration: boolean; worstWeekRule: boolean | null } }, holmRejected: boolean) {
  const sign = (v: number) => v > 0 ? 1 : v < 0 ? -1 : 0;
  const criteria = {
    "1_pairedExcess": holmRejected && e.bootstrap.mean > 0,
    "2_drawdown": e.maxDrawdownMid <= 0.30,
    "3a_overlapConsistency": e.overlapMeanMirror === null || e.overlapMeanAlpaca === null ? null : sign(e.overlapMeanMirror) === sign(e.overlapMeanAlpaca),
    "3b_holdout": e.holdoutMean === null ? null : e.holdoutMean > 0,
    "4_rules": !e.rules.anyLegIntoExpiration && e.rules.worstWeekRule !== false,
  };
  return { criteria, pass: Object.values(criteria).every(v => v === true) };
}

// ── external series (informative only) ──────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  try { const r = await fetch(url); return r.ok ? await r.text() : null; } catch { return null; }
}

export function parseFredCsv(csv: string): Map<Session, number> {
  const out = new Map<Session, number>();
  for (const line of csv.trim().split("\n").slice(1)) { const [d, v] = line.split(","); const x = Number(v); if (Number.isFinite(x) && v.trim() !== ".") out.set(d.trim(), x); }
  return out;
}

export function parseCboeCsv(csv: string): Map<Session, number> {
  const out = new Map<Session, number>();
  for (const line of csv.trim().split("\n").slice(1)) {
    const cols = line.split(",");
    const [mm, dd, yyyy] = cols[0].split("/");
    const close = Number(cols[cols.length === 2 ? 1 : 4]);
    if (Number.isFinite(close) && close > 0) out.set(`${yyyy}-${mm}-${dd}`, close);
  }
  return out;
}

function lastAtOrBefore(m: Map<Session, number>, d: Session): number | undefined {
  let best: Session | undefined;
  for (const k of m.keys()) if (k <= d && (!best || k > best)) best = k;
  return best ? m.get(best) : undefined;
}

/**
 * Weeks of a window: every week with from <= entry <= END, where END is the LAST entry in [from, to]
 * whose eligible expiration exists and exits inside the window (`exitsInside`). Weeks in between with no
 * eligible expiration stay in (the kernel counts them as cash with their reason); weeks after END are out.
 */
export function selectWindowWeeks(weeks: readonly Week[], from: Session, to: Session, exitsInside: (w: Week) => boolean): Week[] {
  const inRange = weeks.filter(w => w.entry >= from && w.entry <= to);
  let end: Session | null = null;
  for (const w of inRange) if (exitsInside(w)) end = w.entry;
  return end === null ? [] : inRange.filter(w => w.entry <= end!);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const outRoot = arg("--out", join(ROOT, "data/backtests"));
  const noFetch = argv.includes("--no-fetch");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const auditPath = expandDataPath("$UC_RESEARCH_DATA_DIR/hist-options-audit.json");
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  if (!audit.gate?.pass) throw new Error("audit gate failed: nothing runs (auditGate.onFailure)");
  for (const [f, h] of Object.entries(manifest.data.primary.sha256)) if (audit.files[f]?.sha256 !== h) throw new Error(`audit hash of ${f} differs from the manifest`);
  const db = openOptionsDb(manifest.data.primary.dbPath, true);
  const ctx = loadContext(db, audit);
  const capital: number = manifest.personality.capitalUsd;

  const codeVersion = sha(["scripts/lib/optionsWeekly.ts", "scripts/lib/optionsData.ts", "scripts/options-r.ts"].map(p => readFileSync(join(ROOT, p), "utf8")).join("\n"));
  const alpacaHash = alpacaTablesHash(db);
  const dataHashes = { ...manifest.data.primary.sha256, alpacaTables: alpacaHash };
  const id = sha(`${canonicalJson(manifest)}|${canonicalJson(dataHashes)}|${codeVersion}`);
  const outDir = join(outRoot, id);
  mkdirSync(outDir, { recursive: true });
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
  console.log(`artifact ${id}\n  code ${codeVersion.slice(0, 12)} git ${git.slice(0, 12)} alpaca tables ${alpacaHash.slice(0, 12)}`);

  const mirrorEnd = ctx.mirrorLast.SPY;
  const lastSession = ctx.sessions[ctx.sessions.length - 1];
  const holdoutCap = HOLDOUT_CAP < lastSession ? HOLDOUT_CAP : lastSession;
  const overlapStart: Session = manifest.windows.overlap.match(/\d{4}-\d{2}-\d{2}/)![0];

  // external series
  let dtb3: Map<Session, number> | null = null, wput: Map<Session, number> | null = null;
  if (!noFetch) {
    const f = await fetchText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3");
    if (f) { writeFileSync(join(outDir, "DTB3.csv"), f); dtb3 = parseFredCsv(f); }
    const c = await fetchText("https://cdn.cboe.com/api/global/us_indices/daily_prices/WPUT_History.csv");
    if (c) { writeFileSync(join(outDir, "WPUT_History.csv"), c); wput = parseCboeCsv(c); }
  }

  const exitWithin = (w: Week, u: string, end: Session) => { const ex = eligibleExpiration(ctx.sessions, w.entry, ctx.listed(u, w.entry)); return ex !== null && ex.exit <= end; };
  const windowWeeks = (from: Session, to: Session, end: Session) => selectWindowWeeks(ctx.weeks, from, to, w => exitWithin(w, "SPY", end));
  const candidateUnderlyings = (c: CandidateName) => c === "O3-convex-buyer" ? ["SPY", "QQQ"] : ["SPY"];

  const evaluations: Record<string, any> = {};
  const bootstraps: Record<string, ReturnType<typeof circularBlockBootstrap>> = {};
  const weeklyFiles: Record<string, WeekRow[]> = {};

  for (const c of CANDIDATES) {
    const us = candidateUnderlyings(c);
    const primaryStart: Session = us.map(u => ctx.audit.calendar[u].primaryWindowStart as Session).sort().at(-1)!;
    const earlyStart: Session = us.map(u => ctx.audit.coverage[u].firstDate as Session).sort().at(-1)!;
    // "hasta la última entrada cuya salida cae dentro del espejo": the SPY week's exit (the candidate's
    // own underlying may be QQQ; both mirrors end the same week)
    // Runs 1–2 (23f5bc9c, a4967757) filtered every week by "exit within the end": a week with NO eligible
    // expiration was dropped instead of counted as cash (calendar.notTradable). The window rule only says
    // where the window ENDS: the last entry whose exit falls inside.
    const primaryWeeks = windowWeeks(primaryStart, mirrorEnd, mirrorEnd);
    const earlyWeeks = ctx.weeks.filter(w => w.entry >= earlyStart && w.entry < primaryStart);
    const overlapWeeks = primaryWeeks.filter(w => w.entry >= overlapStart);
    const holdoutWeeks = windowWeeks(ctx.weeks.find(w => w.entry > mirrorEnd)?.entry ?? holdoutCap, holdoutCap, holdoutCap);
    console.log(`${c}: primary ${primaryWeeks[0]?.entry} → ${primaryWeeks.at(-1)?.entry} (${primaryWeeks.length} weeks), early ${earlyWeeks.length}, overlap ${overlapWeeks.length}, holdout ${holdoutWeeks.length}`);

    const base: RunOptions = { provider: "mirror" };
    const primary = runCandidate(ctx, c, primaryWeeks, base, capital);
    const pStats = runStats(ctx, primary, c)!;
    const xs = primary.filter(r => r.x !== null).map(r => r.x!);
    const boot = circularBlockBootstrap(xs);
    bootstraps[c] = boot;
    const early = earlyWeeks.length ? runCandidate(ctx, c, earlyWeeks, base, capital) : [];
    const overlapMirror = runCandidate(ctx, c, overlapWeeks, base, capital);
    ctx.alpacaClampedDeltas.count = 0;
    const overlapAlpaca = runCandidate(ctx, c, overlapWeeks, { provider: "alpaca" }, capital);
    const holdout = holdoutWeeks.length ? runCandidate(ctx, c, holdoutWeeks, { provider: "alpaca" }, capital) : [];
    const alpacaDeltaClampedQuotes = ctx.alpacaClampedDeltas.count;
    const fractional = runCandidate(ctx, c, primaryWeeks, { ...base, fractional: true }, capital);
    const signalAtEntry = runCandidate(ctx, c, primaryWeeks, { ...base, signalAtEntry: true }, capital);
    const costs2 = runCandidate(ctx, c, primaryWeeks, { ...base, costs: { ...COSTS, multiplier: 2 } }, capital);
    weeklyFiles[`${c}-primary`] = primary; weeklyFiles[`${c}-early`] = early; weeklyFiles[`${c}-overlap-mirror`] = overlapMirror;
    weeklyFiles[`${c}-overlap-alpaca`] = overlapAlpaca; weeklyFiles[`${c}-holdout-alpaca`] = holdout;
    weeklyFiles[`${c}-fractional`] = fractional; weeklyFiles[`${c}-signal-at-entry`] = signalAtEntry; weeklyFiles[`${c}-costs-x2`] = costs2;

    const oM = runStats(ctx, overlapMirror, c), oA = runStats(ctx, overlapAlpaca, c), hS = runStats(ctx, holdout, c);
    const hXs = holdout.filter(r => r.x !== null).map(r => r.x!);
    const hBoot = hXs.length ? circularBlockBootstrap(hXs) : null;
    const corr = pearson(overlapMirror.map(r => r.pnl), overlapAlpaca.map(r => r.pnl));

    // informative
    const half = Math.floor(primary.length / 2);
    const halfStats = (rows: WeekRow[]) => { const s = runStats(ctx, rows, c)!; return { from: s.from, to: s.to, meanX: s.meanX, cagr: s.cagr, spyCagr: s.spyCagr, maxDrawdownMid: s.maxDrawdownMid }; };
    const psr = xs.length > 3 ? psrAndMinTrl(xs) : null;
    let tbill: any = null;
    if (dtb3) {
      let eq = capital, n = 0, sumX = 0, missing = 0;
      for (const r of primary) {
        if (!r.nextEntry) continue;
        const y = lastAtOrBefore(dtb3, r.entry);
        if (y === undefined) { missing++; continue; }
        const rt = y / 100 * calendarDays(r.entry, r.nextEntry) / 360;
        const rc = (1 + r.r) * (1 + rt) - 1;
        eq *= 1 + rc; n++;
        if (r.rSpy !== null) sumX += Math.log(1 + rc) - Math.log(1 + r.rSpy);
      }
      tbill = { weeks: n, missingYield: missing, meanX: n ? sumX / n : null, cagr: (eq / capital) ** (365 / pStats.calendarDays) - 1 };
    }
    let wputCorr: any = null;
    if (c === "O1-put-writer" && wput) {
      const a: number[] = [], b: number[] = [];
      for (const r of primary) { const w0 = r.nextEntry ? wput.get(r.entry) : undefined, w1 = r.nextEntry ? wput.get(r.nextEntry) : undefined; if (w0 && w1) { a.push(r.r); b.push(w1 / w0 - 1); } }
      wputCorr = { weeks: a.length, correlation: pearson(a, b), wputCagr: a.length ? (b.reduce((e, x) => e * (1 + x), 1)) ** (52 / a.length) - 1 : null };
    }
    const qqqBench = c === "O3-convex-buyer" ? (() => { const p = primary.filter(r => r.rQqq !== null); return { weeks: p.length, meanXvsQqq: p.length ? p.reduce((s, r) => s + Math.log(1 + r.r) - Math.log(1 + r.rQqq!), 0) / p.length : null }; })() : null;

    const rules = { anyLegIntoExpiration: pStats.anyLegIntoExpiration, worstWeekRule: pStats.worstWeekPctO2O3Rule };
    evaluations[c] = {
      candidate: c, underlyings: us,
      window: { primaryStart, primaryEnd: primaryWeeks.at(-1)?.entry ?? null, primaryWeeks: primaryWeeks.length, earlyStart, earlyWeeks: earlyWeeks.length,
        overlapStart: overlapWeeks[0]?.entry ?? null, overlapEnd: overlapWeeks.at(-1)?.entry ?? null, holdoutStart: holdoutWeeks[0]?.entry ?? null, holdoutEnd: holdoutWeeks.at(-1)?.entry ?? null },
      primary: pStats, bootstrap: boot,
      early: early.length ? runStats(ctx, early, c) : null,
      overlapMirror: oM, overlapAlpaca: oA, overlapCorrelation: corr,
      holdout: hS, holdoutBootstrap: hBoot,
      informative: {
        fractional: runStats(ctx, fractional, c), signalAtEntry: runStats(ctx, signalAtEntry, c), costsX2: runStats(ctx, costs2, c),
        tbillCollateral: tbill, wput: wputCorr, qqqBenchmark: qqqBench,
        halves: [halfStats(primary.slice(0, half)), halfStats(primary.slice(half))],
        psrExcess: psr,
        liquidationMarkedMaxDrawdown: pStats.maxDrawdownLiquidation,
        shortCallOverExDividendWeeks: pStats.shortCallOverExDividendWeeks,
        cashByReason: pStats.cashByReason, ordersPerWeek: pStats.ordersPerWeek, missingQuotesAtExit: pStats.missingQuotesAtExit,
        alpacaDeltaClampedQuotes,
      },
      rules,
    };
  }

  // Holm over the three candidates
  const ps = CANDIDATES.map(c => bootstraps[c].p);
  const rejected = holm(ps, HOLM_ALPHA);
  CANDIDATES.forEach((c, i) => {
    const e = evaluations[c];
    const ev = evaluateCriteria({ bootstrap: e.bootstrap, maxDrawdownMid: e.primary.maxDrawdownMid, overlapMeanMirror: e.overlapMirror?.meanX ?? null,
      overlapMeanAlpaca: e.overlapAlpaca?.meanX ?? null, holdoutMean: e.holdout?.meanX ?? null, rules: e.rules }, rejected[i]);
    e.holm = { p: ps[i], rejected: rejected[i], alpha: HOLM_ALPHA, family: CANDIDATES.length };
    e.criteria = ev.criteria; e.pass = ev.pass;
    e.verdict = ev.pass ? "PASA" : `NO PASA (${Object.entries(ev.criteria).filter(([, v]) => v !== true).map(([k]) => k).join(", ")})`;
    console.log(`${c}: CAGR ${(e.primary.cagr * 100).toFixed(2)}% vs SPY ${(e.primary.spyCagr * 100).toFixed(2)}%, mean x ${(e.bootstrap.mean * 1e4).toFixed(2)} bp/wk, p ${ps[i].toFixed(4)} Holm ${rejected[i]}, DD mid ${(e.primary.maxDrawdownMid * 100).toFixed(1)}% liq ${(e.primary.maxDrawdownLiquidation * 100).toFixed(1)}% → ${e.verdict}`);
  });

  const summary = {
    artifact: id, manifest: "experiments/options-vega-r-v1.json", manifestHash: sha(canonicalJson(manifest)), codeVersion, git, dataHashes,
    ranAt: new Date().toISOString(), capital, holm: { alpha: HOLM_ALPHA, ps, rejected },
    sessions: { first: ctx.sessions[0], last: lastSession, mirrorEnd, holdoutCap },
    anyPass: CANDIDATES.some(c => evaluations[c].pass),
    candidates: evaluations,
    externalSeries: { dtb3: dtb3 ? dtb3.size : null, wput: wput ? wput.size : null },
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  writeFileSync(join(outDir, "manifest-resolved.json"), JSON.stringify({ ...manifest, resolved: {
    dbPath: expandDataPath(manifest.data.primary.dbPath), auditPath, windows: Object.fromEntries(CANDIDATES.map(c => [c, evaluations[c].window])),
    hTable: ctx.hTable, deltaBuckets: DELTA_BUCKETS, codeVersion, dataHashes, alpacaQuoteRule: "bar close = mid; IV and delta from it; bid = p(1-h), ask = p(1+h), h by the entry-day |delta| bucket of that session, |delta| > 0.65 → last bucket; no bar = unusable; the mirror's spread filter does not apply to synthetic quotes" } }, null, 1));
  for (const [name, rows] of Object.entries(weeklyFiles)) writeFileSync(join(outDir, `weekly-${name}.jsonl`), rows.map(r => JSON.stringify({ ...r, dailyMid: undefined, dailyLiquidation: undefined, daily: r.dailyMid.map((d, i) => [d.session, d.equity, r.dailyLiquidation[i]?.equity]) })).join("\n") + "\n");
  writeFileSync(join(outDir, "audit.json"), readFileSync(auditPath));
  console.log(`written ${outDir}`);
  db.close();
  return { id, outDir, summary };
}

if (import.meta.main) await main();
