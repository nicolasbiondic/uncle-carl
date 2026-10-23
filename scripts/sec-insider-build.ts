#!/usr/bin/env bun
/**
 * Parse the cached SEC insider zips (scripts/sec-insider-fetch.ts) into
 * $UC_RESEARCH_DATA_DIR/signals.db, table signal_events, source "sec-form4-buy":
 * one row per open-market purchase (transaction code P) of a Form 4 / 4/A.
 * Idempotent: only the rows of this source are replaced; other producers'
 * rows in the same file are never touched.
 *
 *   bun scripts/sec-insider-build.ts [--zips <dir>] [--out <signals.db>] [--membership <hist-sp500.db>] [--index sp500] [--emit-from 2015-01-01]
 *
 * Every zip feeds the opportunistic/routine history (open-market P and S trades by owner and
 * calendar month, point in time by filing date); only filings dated >= --emit-from become rows
 * (the earlier quarters exist to classify the first events). Writes descriptive statistics only
 * (events per year, share mapped to the point-in-time S&P 500 members, filing-lag distribution,
 * insider classes, 10b5-1 coverage, merged joint filings) next to the database as
 * signals-sec-form4-buy.stats.json. No prices, no returns, no event study.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { researchDataPath } from "./lib/researchData";
import { IndexMembershipView } from "./lib/portfolioData";
import { defaultSignalsDbPath, openSignalsDbForWrite, replaceSourceRows } from "./lib/signalData";
import { SEC_FORM4_BUY_SOURCE, buysToRows, extractBuys, listZip, newBuildContext, readZipText, summarizeRows, type SecBuy, type TradeHistory } from "./lib/secInsider";

/** First calendar year a run of quarterly zips covers COMPLETELY (2012q1 → 2012; 2012q3 → 2013). */
export function firstFullYearOf(firstLabel: string): number {
  const year = Number(firstLabel.slice(0, 4));
  return firstLabel.endsWith("q1") ? year : year + 1;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const zipDir = flag("--zips") ?? researchDataPath("sec-insider");
  const out = flag("--out") ?? defaultSignalsDbPath();
  const membershipDb = flag("--membership") ?? researchDataPath("hist-sp500.db");
  const indexId = flag("--index") ?? "sp500";
  const emitFrom = flag("--emit-from") ?? "2015-01-01";

  const mdb = new Database(membershipDb, { readonly: true });
  const membership = IndexMembershipView.load(mdb, indexId);
  mdb.close();
  const memberSets = new Map<string, Set<string>>();
  const isMember = (symbol: string, date: string) => {
    let s = memberSets.get(date);
    if (!s) { s = new Set(membership.members(date)); memberSets.set(date, s); }
    return s.has(symbol);
  };

  const zips = readdirSync(zipDir).filter(f => /^\d{4}q[1-4]_form345\.zip$/.test(f)).sort();
  if (zips.length === 0) throw new Error(`no insider zips in ${zipDir} (run scripts/sec-insider-fetch.ts first)`);
  const history: TradeHistory = new Map();
  const allBuys: SecBuy[] = [];
  const total = { form4Submissions: 0, purchaseRows: 0, tradeRows: 0, badFilingDate: 0, badTxDate: 0, noOwner: 0 };
  for (const f of zips) {
    const buf = readFileSync(join(zipDir, f));
    const entries = listZip(buf);
    const { buys, counts } = extractBuys({
      submission: readZipText(buf, "SUBMISSION.tsv", entries),
      owners: readZipText(buf, "REPORTINGOWNER.tsv", entries),
      trans: readZipText(buf, "NONDERIV_TRANS.tsv", entries),
      footnotes: readZipText(buf, "FOOTNOTES.tsv", entries),
    }, history);
    for (const b of buys) allBuys.push(b);
    total.form4Submissions += counts.form4Submissions;
    total.purchaseRows += counts.purchaseRows;
    total.tradeRows += counts.tradeRows;
    total.badFilingDate += counts.badFilingDate;
    total.badTxDate += counts.badTxDate;
    total.noOwner += counts.noOwner;
    console.log(`${f.slice(0, 6)}  form4 filings ${counts.form4Submissions}  purchases ${counts.purchaseRows}  P+S trades ${counts.tradeRows}`);
  }

  const firstFullYear = firstFullYearOf(zips[0].slice(0, 6));
  const built = buysToRows(allBuys, isMember, newBuildContext({ history, firstFullYear, emitFrom }));
  const rows = built.rows;

  const db = openSignalsDbForWrite(out);
  const n = replaceSourceRows(db, SEC_FORM4_BUY_SOURCE, rows);
  db.close();

  const stats = {
    ...summarizeRows(rows),
    build: {
      zips: `${zips[0].slice(0, 6)} … ${zips[zips.length - 1].slice(0, 6)} (${zips.length})`, emitFrom, classificationFirstFullYear: firstFullYear, historyOwnerMonths: history.size,
      ...total, ...built.stats, membershipDb: "hist-sp500.db", index: indexId,
      knownAtRule: "17:30 America/New_York of FILING_DATE (no acceptance time in the data sets)",
    },
  };
  const statsPath = join(dirname(out), "signals-sec-form4-buy.stats.json");
  writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  console.log(`\nwrote ${n} rows to ${out}\nstats: ${statsPath}`);
  console.log(`first known ${stats.firstKnownIso}  last known ${stats.lastKnownIso}`);
  for (const [y, b] of Object.entries(stats.byYear)) {
    const c = b.classSp500OfficerDirector;
    console.log(`${y}  events ${String(b.events).padStart(6)}  sp500 ${String(b.sp500Events).padStart(5)} (${(b.sp500Share * 100).toFixed(1)}%)  symbols ${b.symbols}/${b.sp500Symbols}  officer|director ${b.officerOrDirectorEvents}  sp500-od opp/rout/unk ${c.opportunistic}/${c.routine}/${c.unknown}  10b5-1 ${b.plan.flaggedAny} (field ${b.plan.fieldPresent})  lag>30 ${b.lagOver30.all}/${b.lagOver30.sp500OfficerDirector}`);
  }
  const l = stats.lagDays;
  console.log(`lag days (tx → filing): n=${l.n} mean=${l.mean.toFixed(2)} p10=${l.p10} p50=${l.p50} p90=${l.p90} p99=${l.p99} max=${l.max} share≤2d=${(l.share0to2 * 100).toFixed(1)}% >5d=${(l.shareOver5 * 100).toFixed(1)}% >30d=${l.over30} >365d=${l.over365} negative=${l.negative}`);
  console.log(`sp500-mapped dollars: n=${stats.sp500Dollars.n} p50=${Math.round(stats.sp500Dollars.p50)} p90=${Math.round(stats.sp500Dollars.p90)} max=${Math.round(stats.sp500Dollars.max)} >1e9: ${stats.sp500Dollars.over1e9}`);
  console.log(`build counts: ${JSON.stringify({ ...total, ...built.stats })}`);
}

if (import.meta.main) main();
