import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ALL_PROFILE_IDS, MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "./riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { MOMENTUM_STOCKS_DAILY_HORIZON } from "../index";

// README.md's sleeve table is the canonical doc source (AGENTS.md points
// here instead of duplicating it — one table, one place to drift). This
// suite fails if the table and the code disagree, in EITHER direction:
// change the code without the doc, or edit the doc without the code, and
// one of the three tests below breaks. That's the whole point — see
// AGENTS.md 2026-07-28 entry in AUDITS.md for what happens when nothing
// enforces this (momentum_crypto_usdc silently missing from every doc for
// days after it shipped).
const README_PATH = join(import.meta.dir, "../../README.md");
const INDEX_PATH = join(import.meta.dir, "../index.ts");

interface ReadmeRow {
  id: string;
  universeCount: number;
  cadence: string; // "60" or "daily"
  mode: "live" | "shadow";
}

function parseReadmeSleeveTable(readme: string): ReadmeRow[] {
  const rowRe = /^\|\s*`([a-z_]+)`\s*\|[^|]+\|\s*(\d+)\s*\|\s*(\d+|daily)\s*\|\s*(live|shadow)/gm;
  const rows: ReadmeRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(readme))) {
    rows.push({ id: m[1], universeCount: Number(m[2]), cadence: m[3], mode: m[4] as "live" | "shadow" });
  }
  return rows;
}

// Parses `governor.register({ sleeve: "X", kind: "live"|"shadow", ... })`
// blocks out of index.ts — the actual runtime source of truth for mode.
function parseIndexTsGovernorKinds(indexTs: string): Record<string, "live" | "shadow"> {
  const blockRe = /governor\.register\(\{\s*sleeve:\s*"([a-z_]+)",\s*kind:\s*"(live|shadow)"/g;
  const out: Record<string, "live" | "shadow"> = {};
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(indexTs))) out[m[1]] = m[2] as "live" | "shadow";
  return out;
}

const README = readFileSync(README_PATH, "utf-8");
const INDEX_TS = readFileSync(INDEX_PATH, "utf-8");
const readmeRows = parseReadmeSleeveTable(README);
const readmeById = Object.fromEntries(readmeRows.map((r) => [r.id, r]));
const indexKinds = parseIndexTsGovernorKinds(INDEX_TS);

describe("README sleeve table vs code (src/config/docs.test.ts)", () => {
  test("every ALL_PROFILE_IDS entry has a row in README's sleeve table", () => {
    // This is the test that would have failed the day momentum_crypto_usdc
    // shipped without a doc update — it's a live money-path sleeve missing
    // from ALL_PROFILE_IDS's mirror in the doc is exactly the class of gap
    // this file exists to catch.
    const missing = ALL_PROFILE_IDS.filter((id) => !readmeById[id]);
    expect(missing).toEqual([]);
  });

  test("README universe counts match the code's universe constants", () => {
    expect(readmeById.momentum_stocks?.universeCount).toBe(MOMENTUM_STOCKS_UNIVERSE.length);
    expect(readmeById.meanrev_stocks?.universeCount).toBe(MEANREV_UNIVERSE.length);
    expect(readmeById.momentum_crypto?.universeCount).toBe(MOMENTUM_CRYPTO_UNIVERSE.length);
    expect(readmeById.momentum_crypto_usdc?.universeCount).toBe(Object.keys(USDC_SYMBOL_MAP).length);
    expect(readmeById.momentum_btc?.universeCount).toBe(1); // single-symbol COIN-M sleeve
  });

  test("README live/shadow mode matches governor.register(...) kind in index.ts", () => {
    for (const id of ALL_PROFILE_IDS) {
      expect(indexKinds[id], `governor.register kind missing for "${id}" in index.ts`).toBeDefined();
      expect(readmeById[id]?.mode, `README row missing/malformed for "${id}"`).toBe(indexKinds[id]);
    }
  });

  // Audit fix (2026-09-09): the table above is enforced against the
  // REGISTERED default (governor.register(..., kind:)) only — it says
  // nothing about a later manual override in the `sleeve_modes` table
  // (scripts/set-sleeve-mode.ts), which is the sleeve's actual EFFECTIVE
  // mode (SwitchingAdapter routes off SleeveGovernor.getMode(), which reads
  // the DB row when present). Without this note, README's "shadow" for
  // momentum_crypto reads as the operative truth when it registered shadow
  // but has run LIVE since 2026-08-08. This doesn't (and can't) validate the
  // override's CONTENT from static text — it only fails if the doc stops
  // pointing readers at the one place that does (`/healthz/full`).
  test("README documents that effective mode can diverge from the registered default", () => {
    expect(README).toContain("Modo efectivo");
    expect(README).toContain("/healthz/full");
    expect(README).toContain("sleeveModes");
  });

  test("README cadence matches index.ts's rebalanceMinutes literal for the 4 momentum sleeves", () => {
    // All 4 momentum engines (stocks/crypto/crypto_usdc/btc) are configured
    // with the SAME `rebalanceMinutes: 60` literal today. If a future change
    // gives one of them a different cadence without updating README (or vice
    // versa), this count stops matching and the test fails — it caught the
    // real "doc says 4h, code says 60min" contradiction on momentum_crypto.
    // momentum_stocks keeps the (unconsumed) literal but is driven by the
    // once-a-day ≥09:35 ET scheduler whenever MOMENTUM_STOCKS_DAILY_HORIZON
    // is set — README must then say "daily".
    // momentum_crypto_usdc runs the DAILY kernel since 2026-09-26 (U1,
    // artifact 752767ae…): engine-driven `rebalanceMinutes: 1440` (one
    // decision per UTC day at 00:00 + 15s via nextAlignedTickDelayMs) —
    // README must say "daily" for it, like the stocks daily horizon.
    const momentumSleeves = ["momentum_stocks", "momentum_crypto", "momentum_crypto_usdc", "momentum_btc"];
    const dailySleeves = new Set<string>(["momentum_crypto_usdc", ...(MOMENTUM_STOCKS_DAILY_HORIZON ? ["momentum_stocks"] : [])]);
    for (const id of momentumSleeves) {
      const expected = dailySleeves.has(id) ? "daily" : "60";
      expect(readmeById[id]?.cadence, `README cadence for "${id}"`).toBe(expected);
    }
    const rebalance60Count = (INDEX_TS.match(/rebalanceMinutes: 60,/g) ?? []).length;
    expect(rebalance60Count).toBe(momentumSleeves.length - 1); // usdc wires 1440
    expect((INDEX_TS.match(/rebalanceMinutes: 1440,/g) ?? []).length).toBe(1); // the usdc daily kernel

    // meanrev_stocks is documented as "daily" and driven by the ≥09:35 ET
    // scheduler, not rebalanceMinutes.
    expect(readmeById.meanrev_stocks?.cadence).toBe("daily");
    expect(INDEX_TS).toContain("9 * 60 + 35"); // ≥ 09:35 ET gate in scheduleDailyStockRun
  });
});
