#!/usr/bin/env bun
/**
 * Download the SEC "Insider Transactions Data Sets" (Forms 3/4/5, one zip per
 * quarter) into $UC_RESEARCH_DATA_DIR/sec-insider/ (never in git). Cached: a
 * zip already on disk that reads as a complete archive is not downloaded again.
 *
 *   SEC_USER_AGENT="UncleCarlResearch you@example.com" bun scripts/sec-insider-fetch.ts [--from 2015q1] [--to 2026q4] [--dir <path>]
 *
 * SEC fair-access rules: a descriptive User-Agent WITH a contact address
 * (required here: no default, so no address is committed) and <= 10 requests
 * per second; this stays at <= 5 (one request per 250 ms minimum, sequential).
 * Quarters not published yet answer 404 and are reported, not failed. 2012q1+ by default:
 * the events start in 2015, the three earlier years are the history the opportunistic/routine
 * classification needs (Cohen-Malloy-Pomorski: the same month in each of the three previous years).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { researchDataPath } from "./lib/researchData";
import { listZip } from "./lib/secInsider";

const BASE = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets";
export const MIN_INTERVAL_MS = 250; // <= 4 requests/second, under the 5/s cap

export interface Quarter { year: number; q: number; label: string }

export function parseQuarter(s: string): Quarter {
  const m = /^(\d{4})q([1-4])$/i.exec(s);
  if (!m) throw new Error(`quarter must look like 2015q1, got "${s}"`);
  return { year: Number(m[1]), q: Number(m[2]), label: `${m[1]}q${m[2]}`.toLowerCase() };
}

export function quartersBetween(from: Quarter, to: Quarter): Quarter[] {
  const out: Quarter[] = [];
  for (let y = from.year, q = from.q; y < to.year || (y === to.year && q <= to.q); q === 4 ? (y++, q = 1) : q++) {
    out.push({ year: y, q, label: `${y}q${q}` });
  }
  return out;
}

export function currentQuarter(now = new Date()): Quarter {
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return { year: now.getUTCFullYear(), q, label: `${now.getUTCFullYear()}q${q}` };
}

// The SEC moved the files in 2026: up to 2026q1 under /structureddata/, from 2026q2 under
// /datastandardsinnovation/. Both are tried (the expected one first); a 404 on both = not published.
const BASE_OLD = BASE;
const BASE_NEW = "https://www.sec.gov/files/datastandardsinnovation/data/insider-transactions-data-sets";

export function zipUrls(label: string): string[] {
  const newFirst = label >= "2026q2";
  const bases = newFirst ? [BASE_NEW, BASE_OLD] : [BASE_OLD, BASE_NEW];
  return bases.map(b => `${b}/${label}_form345.zip`);
}
export function zipUrl(label: string): string { return zipUrls(label)[0]; }
export function zipCachePath(dir: string, label: string): string { return join(dir, `${label}_form345.zip`); }

/** True when the cached file is a complete zip (a half-downloaded file has no central directory). */
export function cachedZipIsValid(path: string): boolean {
  if (!existsSync(path)) return false;
  try { listZip(readFileSync(path)); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent || !userAgent.includes("@")) {
    throw new Error('SEC_USER_AGENT must be a descriptive User-Agent with a contact address, e.g. SEC_USER_AGENT="UncleCarlResearch you@example.com" (SEC fair-access policy)');
  }
  const dir = flag("--dir") ?? researchDataPath("sec-insider");
  mkdirSync(dir, { recursive: true });
  const quarters = quartersBetween(parseQuarter(flag("--from") ?? "2012q1"), parseQuarter(flag("--to") ?? currentQuarter().label));
  let lastRequestAt = 0;
  const have: string[] = [], missing: string[] = [];
  for (const q of quarters) {
    const path = zipCachePath(dir, q.label);
    if (cachedZipIsValid(path)) { have.push(q.label); console.log(`cached  ${q.label}`); continue; }
    let done = false;
    const urls = zipUrls(q.label);
    let urlIdx = 0;
    for (let attempt = 1; attempt <= 5 && !done; attempt++) {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const res = await fetch(urls[urlIdx], { headers: { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate" } });
      if (res.status === 404) {
        if (urlIdx + 1 < urls.length) { urlIdx++; attempt--; continue; }
        missing.push(q.label); console.log(`404     ${q.label} (not published)`); done = true; break;
      }
      if (res.status === 429 || res.status >= 500) {
        const backoff = 2_000 * 2 ** (attempt - 1);
        console.log(`${res.status}     ${q.label}: retry in ${backoff} ms`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`${q.label}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const part = `${path}.part`;
      writeFileSync(part, bytes);
      try { listZip(bytes); } catch (e) { rmSync(part, { force: true }); throw new Error(`${q.label}: downloaded file is not a complete zip (${(e as Error).message})`); }
      renameSync(part, path);
      have.push(q.label);
      console.log(`fetched ${q.label} ${(bytes.length / 1e6).toFixed(1)} MB`);
      done = true;
    }
    if (!done) throw new Error(`${q.label}: gave up after 5 attempts`);
  }
  console.log(`\nhave ${have.length} quarters (${have[0] ?? "-"} … ${have[have.length - 1] ?? "-"}); unpublished: ${missing.join(", ") || "none"}`);
}

if (import.meta.main) await main();
