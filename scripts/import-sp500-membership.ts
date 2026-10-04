#!/usr/bin/env bun
/**
 * Import the S&P 500 historical membership (fja05680/sp500, MIT) into the
 * RESEARCH historical DB's `index_membership` table — one membership TRAMO
 * per row (start_date INCLUSIVE, end_date EXCLUSIVE removal date, NULL =
 * current member). Data is pinned to commit SP500_SOURCE_COMMIT for
 * reproducibility; the small start/end CSV is also vendored under
 * vendor/sp500/ (MIT LICENSE + NOTICE.md) so a clean checkout reproduces
 * without the network (--offline).
 *
 * VALIDATION (fail-closed, online mode): the tramo file is cross-checked
 * against the same commit's "S&P 500 Historical Components & Changes
 * (Updated).csv" — on sampled composition dates the membership
 * reconstructed from tramos must EXACTLY equal that date's component list
 * (retired tickers' "-YYYYMM" reuse suffixes stripped). Semantics verified
 * 2026-10-02: start inclusive / end exclusive reproduces 62/62 sampled
 * dates. --offline skips this check (components CSV is 7.8 MB and not
 * vendored) and reads the vendored tramo CSV instead of the network.
 *
 * Usage:
 *   bun run scripts/import-sp500-membership.ts [--db ./data/historical.db] [--offline]
 *
 * Research only — nothing live reads index_membership.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const SP500_SOURCE_COMMIT = "a2430f2af0c79ddf0748e91de11bdeb1616ab5a7";
export const SP500_SOURCE = "fja05680/sp500";
export const SP500_INDEX_ID = "sp500";
const RAW_BASE = `https://raw.githubusercontent.com/fja05680/sp500/${SP500_SOURCE_COMMIT}`;
export const START_END_URL = `${RAW_BASE}/sp500_ticker_start_end.csv`;
// The commit also carries "S&P 500 Historical Components & Changes.csv",
// but its last composition row is 2019-01-11; the "(Updated)" variant
// extends to 2026-08-18 and is the one the validation can use.
export const COMPONENTS_URL = `${RAW_BASE}/S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv`;
export const VENDORED_START_END = join(import.meta.dir, "..", "vendor", "sp500", "sp500_ticker_start_end.csv");

export interface MembershipTramoRow {
  ticker: string;
  startDate: string;          // YYYY-MM-DD, inclusive
  endDate: string | null;     // YYYY-MM-DD, EXCLUSIVE removal date; null = current
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict calendar-date check: format AND a real date (2020-13-99 fails). */
function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const ms = Date.parse(d);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
}

/** Parse sp500_ticker_start_end.csv. Fail-closed on any malformed row. */
export function parseStartEndCsv(text: string): MembershipTramoRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== "ticker,start_date,end_date") {
    throw new Error(`unexpected header: ${JSON.stringify(lines[0])}`);
  }
  const rows: MembershipTramoRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const parts = lines[i].split(",");
    if (parts.length !== 3) throw new Error(`line ${i + 1}: expected 3 fields, got ${parts.length}`);
    const [ticker, startDate, endRaw] = parts.map(p => p.trim());
    const endDate = endRaw === "" ? null : endRaw;
    if (!ticker) throw new Error(`line ${i + 1}: empty ticker`);
    if (!isValidDate(startDate)) throw new Error(`line ${i + 1}: bad start_date ${JSON.stringify(startDate)}`);
    if (endDate !== null && !isValidDate(endDate)) throw new Error(`line ${i + 1}: bad end_date ${JSON.stringify(endDate)}`);
    if (endDate !== null && endDate <= startDate) throw new Error(`line ${i + 1}: end_date ${endDate} <= start_date ${startDate}`);
    rows.push({ ticker, startDate, endDate });
  }
  if (rows.length === 0) throw new Error("no tramo rows parsed");
  // A ticker must not have two OVERLAPPING tramos (end exclusive ⇒ a new
  // tramo may start exactly at a prior tramo's end).
  const byTicker = new Map<string, MembershipTramoRow[]>();
  for (const r of rows) (byTicker.get(r.ticker) ?? byTicker.set(r.ticker, []).get(r.ticker)!).push(r);
  for (const [ticker, trs] of byTicker) {
    const sorted = [...trs].sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].endDate;
      if (prevEnd === null || sorted[i].startDate < prevEnd) {
        throw new Error(`overlapping tramos for ${ticker}: ${JSON.stringify(sorted[i - 1])} vs ${JSON.stringify(sorted[i])}`);
      }
    }
  }
  return rows;
}

/** Parse the components-by-date CSV (date,"T1,T2,..."). */
export function parseComponentsCsv(text: string): Array<{ date: string; tickers: string[] }> {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== "date,tickers") throw new Error(`unexpected components header: ${JSON.stringify(lines[0])}`);
  const out: Array<{ date: string; tickers: string[] }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const comma = line.indexOf(",");
    const date = line.slice(0, comma);
    if (!isValidDate(date)) throw new Error(`components line ${i + 1}: bad date ${JSON.stringify(date)}`);
    let tickersField = line.slice(comma + 1);
    if (tickersField.startsWith('"') && tickersField.endsWith('"')) tickersField = tickersField.slice(1, -1);
    out.push({ date, tickers: tickersField.split(",").map(t => t.trim()).filter(t => t.length > 0) });
  }
  if (out.length === 0) throw new Error("no component rows parsed");
  return out;
}

/** Strip the retired-ticker reuse suffix ("AAL-199702" → "AAL"). */
export function stripReuseSuffix(ticker: string): string {
  return ticker.replace(/-\d{6}$/, "");
}

/** Membership reconstructed from tramos at a YYYY-MM-DD date (start inclusive, end EXCLUSIVE). */
export function reconstructMembersAt(tramos: MembershipTramoRow[], date: string): Set<string> {
  const out = new Set<string>();
  for (const t of tramos) {
    if (t.startDate <= date && (t.endDate === null || date < t.endDate)) out.add(t.ticker);
  }
  return out;
}

export interface ValidationResult {
  checkedDates: number;
  mismatches: Array<{ date: string; onlyComponents: string[]; onlyTramos: string[] }>;
}

/**
 * Cross-check tramos against the components-by-date list on sampled dates
 * (every `sampleEvery`-th composition row, plus the first and last rows).
 * A single mismatching date is a hard failure for the caller.
 */
export function validateAgainstComponents(
  tramos: MembershipTramoRow[],
  components: Array<{ date: string; tickers: string[] }>,
  sampleEvery = 25,
): ValidationResult {
  const indices = new Set<number>([0, components.length - 1]);
  for (let i = 0; i < components.length; i += sampleEvery) indices.add(i);
  const mismatches: ValidationResult["mismatches"] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const row = components[i];
    const expected = new Set(row.tickers.map(stripReuseSuffix));
    const got = reconstructMembersAt(tramos, row.date);
    const onlyComponents = [...expected].filter(t => !got.has(t)).sort();
    const onlyTramos = [...got].filter(t => !expected.has(t)).sort();
    if (onlyComponents.length > 0 || onlyTramos.length > 0) {
      mismatches.push({ date: row.date, onlyComponents, onlyTramos });
    }
  }
  return { checkedDates: indices.size, mismatches };
}

/**
 * Create (if needed) and atomically repopulate index_membership for one
 * index_id: all rows of that index are replaced in a single transaction.
 * Returns the number of rows written.
 */
export function writeMembership(
  db: Database,
  tramos: MembershipTramoRow[],
  meta: { indexId: string; source: string; sourceCommit: string },
): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_membership (
      index_id      TEXT NOT NULL,
      ticker        TEXT NOT NULL,
      start_date    TEXT NOT NULL,
      end_date      TEXT,
      source        TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      PRIMARY KEY (index_id, ticker, start_date)
    );
  `);
  const insert = db.prepare(
    `INSERT INTO index_membership (index_id, ticker, start_date, end_date, source, source_commit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM index_membership WHERE index_id = ?`).run(meta.indexId);
    for (const t of tramos) {
      insert.run(meta.indexId, t.ticker, t.startDate, t.endDate, meta.source, meta.sourceCommit);
    }
  });
  txn();
  return tramos.length;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

if (import.meta.main) {
  const argOf = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const dbPath = argOf("--db") ?? "./data/historical.db";
  const offline = process.argv.includes("--offline");

  let startEndText: string;
  if (offline) {
    console.log(`offline: reading vendored ${VENDORED_START_END}`);
    startEndText = readFileSync(VENDORED_START_END, "utf-8");
  } else {
    console.log(`fetching ${START_END_URL}`);
    startEndText = await fetchText(START_END_URL);
  }
  const tramos = parseStartEndCsv(startEndText);
  const tickers = new Set(tramos.map(t => t.ticker));
  const multi = tramos.length - tickers.size;
  console.log(`parsed ${tramos.length} tramos, ${tickers.size} tickers (${multi} extra tramos on reused/re-added tickers)`);

  if (offline) {
    console.log("offline: components cross-validation SKIPPED (was performed online at import time; see vendor/sp500/NOTICE.md)");
  } else {
    console.log(`fetching ${COMPONENTS_URL}`);
    const components = parseComponentsCsv(await fetchText(COMPONENTS_URL));
    const v = validateAgainstComponents(tramos, components);
    for (const m of v.mismatches) {
      console.error(`  MISMATCH ${m.date}: only-in-components=${m.onlyComponents.join("/") || "-"} only-in-tramos=${m.onlyTramos.join("/") || "-"}`);
    }
    if (v.mismatches.length > 0) {
      console.error(`validation FAILED on ${v.mismatches.length}/${v.checkedDates} sampled dates — nothing written`);
      process.exit(1);
    }
    console.log(`validation OK: ${v.checkedDates} sampled composition dates reproduced exactly (suffixes stripped)`);
    // Refresh the vendored copy so a clean checkout reproduces this import.
    writeFileSync(VENDORED_START_END, startEndText);
  }

  const db = new Database(dbPath);
  try {
    const written = writeMembership(db, tramos, {
      indexId: SP500_INDEX_ID,
      source: SP500_SOURCE,
      sourceCommit: SP500_SOURCE_COMMIT,
    });
    const since2016 = reconstructMembersAt(tramos, "2016-01-04");
    const overlap2016 = new Set<string>();
    for (const t of tramos) if (t.endDate === null || t.endDate >= "2016-01-01") overlap2016.add(t.ticker);
    console.log(`wrote ${written} rows to ${dbPath} index_membership (index_id=${SP500_INDEX_ID}, commit ${SP500_SOURCE_COMMIT.slice(0, 7)})`);
    console.log(`members on 2016-01-04: ${since2016.size}; tickers with a tramo overlapping 2016+: ${overlap2016.size}`);
  } finally {
    db.close();
  }
}
