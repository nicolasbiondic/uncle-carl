#!/usr/bin/env bun
/**
 * Weekly restore drill — the verification half (audit F-9, 2026-11-07: the
 * backups had never been restored). scripts/restore-drill.sh restores the
 * latest daily backup into a TEMP data dir with the real scripts/restore-db.sh
 * and then runs this against that dir:
 *   1. PRAGMA integrity_check on the restored trading.db;
 *   2. the core tables exist and the book is not empty (trades rows);
 *   3. the backup is recent: newest equity snapshot ≤ --max-age-hours old;
 *   4. every sealed broker account in platform_broker_accounts opens with a
 *      BACKED-UP master key (data/backups/master-<sha12>.key, written by
 *      backup-db.sh) — never the live data/master.key;
 *   5. restored risk-state JSON files parse.
 * Read-only on the restored copy; prints no plaintext, key or path to a key's
 * content. Exit 0 = drill passed, 1 = drill failed, 2 = bad usage.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSecretBox, decodeMasterKey } from "../src/platform/secretBox";

export interface DrillResult { ok: boolean; lines: string[] }

const REQUIRED_TABLES = ["trades", "equity_snapshots"];

export function runRestoreDrill(opts: { dataDir: string; keysDir: string; maxAgeHours?: number; now?: number }): DrillResult {
  const lines: string[] = [];
  let ok = true;
  const fail = (msg: string) => { ok = false; lines.push(`FAIL ${msg}`); };
  const pass = (msg: string) => lines.push(`OK   ${msg}`);
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeHours ?? 26) * 3_600_000;

  const dbPath = join(opts.dataDir, "trading.db");
  if (!existsSync(dbPath)) return { ok: false, lines: ["FAIL restored trading.db is missing"] };
  let db: Database;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e: any) { return { ok: false, lines: [`FAIL cannot open the restored DB: ${e?.message ?? e}`] }; }
  try {
    try {
      const r = db.query("PRAGMA integrity_check").get() as Record<string, string>;
      const v = Object.values(r)[0];
      if (v === "ok") pass("integrity_check=ok"); else fail(`integrity_check=${v}`);
    } catch (e: any) { fail(`integrity_check could not run: ${e?.message ?? e}`); }

    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name));
    for (const t of REQUIRED_TABLES) if (!tables.has(t)) fail(`table ${t} missing`);
    if (tables.has("trades")) {
      const n = (db.query("SELECT COUNT(*) n FROM trades").get() as { n: number }).n;
      if (n > 0) pass(`trades rows=${n}`); else fail("trades is empty");
    }
    if (tables.has("equity_snapshots")) {
      const last = (db.query("SELECT MAX(snapshot_time) t FROM equity_snapshots").get() as { t: number | null }).t;
      if (last === null) fail("equity_snapshots is empty");
      else if (now - last > maxAgeMs) fail(`newest equity snapshot is ${((now - last) / 3_600_000).toFixed(1)}h old (> ${maxAgeMs / 3_600_000}h): the backup is stale`);
      else pass(`newest equity snapshot ${((now - last) / 3_600_000).toFixed(1)}h old`);
    }

    // Broker-account registry, opened with the BACKED-UP keys only.
    if (!tables.has("platform_broker_accounts")) {
      pass("no platform_broker_accounts table (registry unused)");
    } else {
      const rows = db.query("SELECT id, credentials_enc FROM platform_broker_accounts WHERE credentials_enc != ''").all() as { id: string; credentials_enc: string }[];
      const keyFiles = existsSync(opts.keysDir)
        ? readdirSync(opts.keysDir).filter(f => /^master-[0-9a-f]{12}\.key$/.test(f)).sort() : [];
      const boxes = keyFiles.flatMap(f => {
        const key = decodeMasterKey(readFileSync(join(opts.keysDir, f), "utf8"));
        return key ? [{ f, box: createSecretBox(key) }] : [];
      });
      if (rows.length === 0) pass("registry has no sealed accounts");
      else if (boxes.length === 0) fail(`${rows.length} sealed account(s) but no backed-up master-<sha12>.key in the backup dir`);
      else {
        let opened = 0;
        const used = new Set<string>();
        for (const r of rows) {
          const hit = boxes.find(b => { try { return b.box.open(r.credentials_enc).length > 0; } catch { return false; } });
          if (hit) { opened++; used.add(hit.f); } else fail(`account ${r.id}: no backed-up key opens its credentials`);
        }
        if (opened === rows.length) pass(`registry: ${opened}/${rows.length} account(s) decrypted with ${[...used].join(", ")}`);
      }
    }
  } finally { db.close(); }

  const stateFiles = readdirSync(opts.dataDir).filter(f => /^(momentum|meanrev)-state-.*\.json$/.test(f));
  for (const f of stateFiles) {
    try { JSON.parse(readFileSync(join(opts.dataDir, f), "utf8")); }
    catch { fail(`restored ${f} is not valid JSON`); }
  }
  if (stateFiles.length) pass(`${stateFiles.length} risk-state file(s) restored and parsed`);
  return { ok, lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dataDir = flag("--data-dir"), keysDir = flag("--keys-dir");
  if (!dataDir || !keysDir) { console.error("usage: restore-drill.ts --data-dir <restored data> --keys-dir <backups dir> [--max-age-hours N]"); process.exit(2); }
  const maxAge = flag("--max-age-hours");
  const r = runRestoreDrill({ dataDir, keysDir, maxAgeHours: maxAge ? Number(maxAge) : undefined });
  for (const l of r.lines) console.log(`restore-drill: ${l}`);
  console.log(`restore-drill: ${r.ok ? "PASSED" : "FAILED"}`);
  process.exit(r.ok ? 0 : 1);
}
