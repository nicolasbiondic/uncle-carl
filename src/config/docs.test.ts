import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ALL_PROFILE_IDS, MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "./riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { builtinPortfolio, STOCK_SLEEVE_BUILTIN_DEFINITION } from "../portfolios/builtin";

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
  /** "live" trades; "inactive" = a historical sleeve with no engine (momentum_btc since 2026-11-07). */
  state: "live" | "inactive";
}

function parseReadmeSleeveTable(readme: string): ReadmeRow[] {
  const rowRe = /^\|\s*`([a-z_]+)`\s*\|[^|]+\|\s*(\d+)\s*\|\s*(\d+|daily|—)\s*\|\s*(live|inactive)/gm;
  const rows: ReadmeRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(readme))) {
    rows.push({ id: m[1], universeCount: Number(m[2]), cadence: m[3], state: m[4] as "live" | "inactive" });
  }
  return rows;
}

/** The sleeves main() registers with the governor: the crypto momentum engines
 *  by literal (`governor.register({ sleeve: "X", ...`) and the stock sleeves
 *  through the portfolio-engine loop (`for (const sleeve of portfolioCutoverSleeves)`),
 *  which every stock sleeve enters — registry definition or built-in fallback
 *  (STOCK_SLEEVE_BUILTIN_DEFINITION). Every one of them trades live — there is
 *  no mode since 2026-11-07. */
function parseIndexTsRegisteredSleeves(indexTs: string): Set<string> {
  const blockRe = /governor\.register\(\{\s*sleeve:\s*"([a-z_]+)",/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(indexTs))) out.add(m[1]);
  if (indexTs.includes("for (const sleeve of portfolioCutoverSleeves) {\n    governor.register({ sleeve, evidenceVersion:")) {
    for (const sleeve of Object.keys(STOCK_SLEEVE_BUILTIN_DEFINITION)) out.add(sleeve);
  }
  return out;
}

const README = readFileSync(README_PATH, "utf-8");
const INDEX_TS = readFileSync(INDEX_PATH, "utf-8");
const readmeRows = parseReadmeSleeveTable(README);
const readmeById = Object.fromEntries(readmeRows.map((r) => [r.id, r]));
const indexRegistered = parseIndexTsRegisteredSleeves(INDEX_TS);

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
    // The stock sleeves' universes are the canonical constants AND the ones
    // their portfolio-engine definitions trade (locked to each other in
    // src/portfolios/builtinPortfolioEngine.test.ts).
    expect(readmeById.momentum_stocks?.universeCount).toBe(MOMENTUM_STOCKS_UNIVERSE.length);
    expect(readmeById.momentum_stocks?.universeCount).toBe((builtinPortfolio("pe_momentum_stocks").params as any).strategy.universe.length);
    expect(readmeById.meanrev_stocks?.universeCount).toBe(MEANREV_UNIVERSE.length);
    expect(readmeById.meanrev_stocks?.universeCount).toBe((builtinPortfolio("pe_meanrev_stocks").params as any).strategy.universe.length);
    expect(readmeById.momentum_crypto?.universeCount).toBe(MOMENTUM_CRYPTO_UNIVERSE.length);
    expect(readmeById.momentum_crypto_usdc?.universeCount).toBe(Object.keys(USDC_SYMBOL_MAP).length);
    expect(readmeById.momentum_btc?.universeCount).toBe(0); // engine retired 2026-11-07: no universe trades
  });

  test("README state matches index.ts: a sleeve main() registers with the governor is live; one it never registers is inactive", () => {
    for (const id of ALL_PROFILE_IDS) {
      const expected = indexRegistered.has(id) ? "live" : "inactive";
      expect(readmeById[id]?.state, `README row missing/malformed for "${id}"`).toBe(expected);
    }
    // The owner rule as code: no "shadow" state exists anywhere for a sleeve
    // to be parked in (ShadowAdapter, sleeve_modes routing and
    // scripts/set-sleeve-mode.ts were removed 2026-11-07).
    expect(INDEX_TS).not.toMatch(/kind:\s*"(live|shadow)"/);
    expect(INDEX_TS).not.toContain("ShadowAdapter");
    expect(README).not.toMatch(/\|\s*shadow\s*\|/);
  });

  test("README cadence matches the engines: crypto from index.ts's rebalanceMinutes literal, stocks from the portfolio engine's daily pass", () => {
    // The two Binance momentum engines: momentum_crypto wires
    // `rebalanceMinutes: 60`; momentum_crypto_usdc runs the DAILY kernel since
    // 2026-09-26 (U1, artifact 752767ae…): engine-driven `rebalanceMinutes:
    // 1440` (one decision per UTC day at 00:00 + 15s via
    // nextAlignedTickDelayMs) — README must say "daily" for it. If a future
    // change gives one of them a different cadence without updating README
    // (or vice versa), the counts stop matching — this caught the real "doc
    // says 4h, code says 60min" contradiction on momentum_crypto.
    expect(readmeById.momentum_crypto?.cadence).toBe("60");
    expect(readmeById.momentum_crypto_usdc?.cadence).toBe("daily");
    expect((INDEX_TS.match(/rebalanceMinutes: 60,/g) ?? []).length).toBe(1); // momentum_crypto
    expect((INDEX_TS.match(/rebalanceMinutes: 1440,/g) ?? []).length).toBe(1); // the usdc daily kernel
    expect(readmeById.momentum_btc?.cadence).toBe("—"); // no engine, no cadence

    // The stock sleeves run on the portfolio engine: one pass per NYSE
    // session ≥ 09:35 ET (src/portfolio-engine/live/schedule.ts), so README
    // says "daily" for both. Their TSM/Connors incumbents (and index.ts's
    // ≥09:35 schedulers) were retired 2026-11-07: no stock engine is wired
    // in index.ts any more.
    expect(readmeById.momentum_stocks?.cadence).toBe("daily");
    expect(readmeById.meanrev_stocks?.cadence).toBe("daily");
    expect(INDEX_TS).not.toContain("AlpacaMomentumAdapter");
    expect(INDEX_TS).not.toContain("new MeanRevEngine(");
    expect(INDEX_TS).toContain("STOCK_SLEEVE_BUILTIN_DEFINITION"); // the built-in fallback is wired
  });
});
