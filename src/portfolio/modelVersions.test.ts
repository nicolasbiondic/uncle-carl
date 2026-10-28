// ══════════════════════════════════════════════
// Model versions — the stamp on every trade row and the attribution rule.
//
// Born from the 2026-10-20 forensic audit: all 290 rows said "legacy", so no
// live P&L could be measured per model, and the MODEL_CUTOVER closes credited
// the previous model's windfalls (META +$4,768 under the 5m kernel, UNI/NEAR
// +$2,159 under the hourly USDC model) to the pass that closed them. Pure +
// in-memory DB; no dev .env, no artifacts, no network.
// ══════════════════════════════════════════════

import { beforeEach, describe, expect, test } from "bun:test";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";
import { closeTrade, getDB, updateTradeCloseReason } from "../db/database";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import {
  MODEL_VERSIONS, currentModelStarts, currentModelVersionId, modelVersionAt, rowModelVersion,
} from "./modelVersions";
import {
  MODEL_START, SCORECARD_ENTITIES, computeVersionRecords, computeWindowMetrics, type DailyMark,
} from "./scorecard";

const T = (iso: string) => Date.parse(iso);
const versionOf = (id: string) =>
  (getDB().prepare(`SELECT strategy_version v FROM trades WHERE id = ?`).get(id) as any).v as string;

describe("the version table", () => {
  test("covers exactly the live sleeves, oldest → newest, with unique ids named <sleeve>@<name>", () => {
    expect(Object.keys(MODEL_VERSIONS).sort()).toEqual([...ALL_PROFILE_IDS].sort());
    const seen = new Set<string>();
    for (const [sleeve, list] of Object.entries(MODEL_VERSIONS)) {
      expect(list.length).toBeGreaterThan(0);
      let prev = -Infinity;
      for (const v of list) {
        expect(v.id.startsWith(`${sleeve}@`)).toBe(true);
        expect(seen.has(v.id)).toBe(false);
        seen.add(v.id);
        const since = Date.parse(v.since);
        expect(Number.isNaN(since)).toBe(false);
        expect(since).toBeGreaterThan(prev); // strictly ascending: attribution by entry time is unambiguous
        prev = since;
        expect(v.id).not.toBe("legacy");
        expect(v.id).not.toBe("ops_sync");
      }
    }
  });

  test("momentum_crypto@vt35-corroff-mh120-nobrakes: modelStart is the first FULL UTC day after `since`", () => {
    const v = MODEL_VERSIONS.momentum_crypto.at(-1)!;
    expect(v.id).toBe("momentum_crypto@vt35-corroff-mh120-nobrakes");
    const sinceMs = Date.parse(v.since);
    const nextMidnight = Math.floor(sinceMs / 86_400_000) * 86_400_000 + (sinceMs % 86_400_000 === 0 ? 0 : 86_400_000);
    expect(v.modelStart).toBe(new Date(nextMidnight).toISOString().slice(0, 10));
  });

  test("momentum_crypto_usdc@daily-d13s5-xc-dd (RW4a): since = a DAILY pass instant (00:00:00Z), modelStart = that UTC day; the control is the ONE change vs the control version", () => {
    const list = MODEL_VERSIONS.momentum_crypto_usdc;
    const v = list.find(v => v.id === "momentum_crypto_usdc@daily-d13s5-xc-dd")!; // historical, never rewritten
    expect(v.id).toBe("momentum_crypto_usdc@daily-d13s5-xc-dd");
    expect(v.since).toBe("2026-10-24T00:00:00Z");
    expect(Date.parse(v.since) % 86_400_000).toBe(0); // the sleeve decides once a day at 00:00 UTC (+15s)
    expect(v.modelStart).toBe(v.since.slice(0, 10));
    expect(v.engine).toBeUndefined();
    expect(v.manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json");
    expect(v.artifact).toEqual({ dir: "data/backtests/8892c1e950818ee724cbd5473ffdb6d207aefc98ae1f054d3bdf08e4eebad607", shiftDays: -1 });
    // Rollback target = the control version (the artifact was measured against it).
    const previous = list[list.indexOf(v) - 1];
    expect(previous.id).toBe("momentum_crypto_usdc@daily-d13s5");
    expect(previous.manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-pure-v1.json");
    expect(previous.artifact?.shiftDays).toBe(-1);
  });

  test("Q5 RW5d appends after pe-vt15; Monday first pass and next full session, cash manifest, cash-parity artifact fb410729", () => {
    const list = MODEL_VERSIONS.momentum_stocks;
    const v = list.find(v => v.id === "momentum_stocks@pe-vt30-g250-sma200-fv5")!;
    expect(list[list.indexOf(v) - 1].id).toBe("momentum_stocks@pe-vt15");
    expect(v).toMatchObject({ id: "momentum_stocks@pe-vt30-g250-sma200-fv5", engine: "portfolio",
      since: "2026-10-26T13:35:00Z", modelStart: "2026-10-27",
      manifest: "experiments/rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1.json", candidate: "e1-lev-vt30-g250-sma200-fastvol5",
      artifact: { dir: "data/backtests/fb410729eaf8cbe6efd32c0193f2e23b0313af4ceae0514aebdff1109a66e74b", shiftDays: 0 } });
    expect(modelVersionAt("momentum_stocks", T(v.since) - 1)!.id).toBe("momentum_stocks@pe-vt15");
    expect(modelVersionAt("momentum_stocks", T(v.since))!.id).toBe(v.id);
    expect(rowModelVersion("momentum_stocks", { strategy_version: "momentum_stocks@pe-vt15", entry_time: T(v.since) })).toBe("momentum_stocks@pe-vt15");
  });

  test("RW6 appends all four versions with the approved epochs; inherited rows keep their opening stamp", () => {
    for (const [sleeve, suffix] of Object.entries({
      momentum_stocks: "pe-vt30-g250-sma200-fv5-mh5", meanrev_stocks: "pe-vt15-mh5",
      momentum_crypto: "vt35-corroff-mh120", momentum_crypto_usdc: "daily-d13s5-xc-dd-mh120",
    })) {
      const list = MODEL_VERSIONS[sleeve], v = list.find(v => v.id === `${sleeve}@${suffix}`)!, previous = list[list.indexOf(v) - 1];
      expect(v.id).toBe(`${sleeve}@${suffix}`);
      expect(v.since).toBe(sleeve === "momentum_stocks" ? "2026-10-26T13:35:01Z" : "2026-10-26T13:00:00Z");
      expect(v.modelStart).toBe("2026-10-27");
      expect(modelVersionAt(sleeve, T(v.since) - 1)!.id).toBe(previous.id);
      expect(modelVersionAt(sleeve, T(v.since))!.id).toBe(v.id);
      expect(rowModelVersion(sleeve, { strategy_version: previous.id, entry_time: T(v.since) })).toBe(previous.id);
    }
    expect(MODEL_VERSIONS.momentum_stocks.find(v => v.id === "momentum_stocks@pe-vt30-g250-sma200-fv5-mh5")!.note).toContain("never traded");
    expect(modelVersionAt("momentum_stocks", T("2026-10-26T13:35:15Z"))!.id).toBe("momentum_stocks@pe-vt30-g250-sma200-fv5-mh5");
  });

  test("RW7 appends all four versions at the requested strictly later instant; inherited rows keep their opening version", () => {
    for (const [sleeve, suffix] of Object.entries({
      momentum_stocks: "pe-vt30-g250-sma200-fv5-mh5-stagger", meanrev_stocks: "pe-vt15-mh5-stagger",
      momentum_crypto: "vt35-corroff-mh120-nobrakes", momentum_crypto_usdc: "daily-d13s5-xc-dd-mh120-sizeonly",
    })) {
      const list = MODEL_VERSIONS[sleeve], v = list.at(-1)!, previous = list.at(-2)!;
      expect(v.id).toBe(`${sleeve}@${suffix}`);
      expect(v.since).toBe("2026-10-28T13:00:00Z");
      expect(T(v.since)).toBeGreaterThan(T(previous.since));
      expect(v.modelStart).toBe("2026-10-29");
      expect(v.engine).toBe(sleeve.endsWith("stocks") ? "portfolio" : undefined);
      expect(modelVersionAt(sleeve, T(v.since) - 1)!.id).toBe(previous.id);
      expect(modelVersionAt(sleeve, T(v.since))!.id).toBe(v.id);
      expect(rowModelVersion(sleeve, { strategy_version: previous.id, entry_time: T(v.since) })).toBe(previous.id);
    }
  });

  test("the scorecard's MODEL_START IS the current version's modelStart (one source), for every scorecard sleeve", () => {
    expect(MODEL_START).toEqual(currentModelStarts());
    expect(MODEL_START).toEqual({
      momentum_stocks: "2026-10-29",
      meanrev_stocks: "2026-10-29",
      momentum_crypto: "2026-10-29",
      momentum_crypto_usdc: "2026-10-29",
    });
    for (const e of SCORECARD_ENTITIES.filter(e => e.kind === "sleeve")) {
      expect(MODEL_START[e.id]).toBeTruthy();
      expect(MODEL_VERSIONS[e.id]).toBeDefined();
    }
  });
});

describe("rowModelVersion — a row belongs to the version that OPENED it", () => {
  test("a legacy row resolves by entry time, boundaries included", () => {
    const at = (sleeve: string, iso: string) => rowModelVersion(sleeve, { strategy_version: "legacy", entry_time: T(iso) });
    expect(at("momentum_stocks", "2026-07-10T14:27:33Z")).toBe("momentum_stocks@pre-blend");
    expect(at("momentum_stocks", "2026-09-25T19:59:59Z")).toBe("momentum_stocks@pre-blend");
    expect(at("momentum_stocks", "2026-09-28T13:36:06Z")).toBe("momentum_stocks@blend-k100");
    expect(at("momentum_stocks", "2026-10-12T13:36:35Z")).toBe("momentum_stocks@blend-k150");
    expect(at("meanrev_stocks", "2026-09-25T13:36:31Z")).toBe("meanrev_stocks@slot10");
    expect(at("meanrev_stocks", "2026-09-28T13:36:00Z")).toBe("meanrev_stocks@slot12");
    expect(at("momentum_crypto", "2026-09-22T00:00:20Z")).toBe("momentum_crypto@pre-vt35");
    expect(at("momentum_crypto", "2026-09-26T19:48:19Z")).toBe("momentum_crypto@vt35");
    expect(at("momentum_crypto", "2026-10-23T08:59:59Z")).toBe("momentum_crypto@vt35");
    expect(at("momentum_crypto", "2026-10-23T09:00:00Z")).toBe("momentum_crypto@vt35-corroff");
    expect(at("momentum_crypto_usdc", "2026-08-29T01:16:52Z")).toBe("momentum_crypto_usdc@hourly-13b");
    expect(at("momentum_crypto_usdc", "2026-09-27T00:00:21Z")).toBe("momentum_crypto_usdc@daily-d13s5");
    expect(at("momentum_crypto_usdc", "2026-10-23T23:59:59Z")).toBe("momentum_crypto_usdc@daily-d13s5");
    expect(at("momentum_crypto_usdc", "2026-10-24T00:00:15Z")).toBe("momentum_crypto_usdc@daily-d13s5-xc-dd");
    expect(modelVersionAt("momentum_btc", T("2026-07-22T01:38:47Z"))?.id).toBe("momentum_btc@hourly-coinm");
  });

  test("ops_sync adoption rows are attributed by entry time too", () => {
    expect(rowModelVersion("momentum_crypto", { strategy_version: "ops_sync", entry_time: T("2026-10-01T00:00:00Z") }))
      .toBe("momentum_crypto@vt35");
  });

  test("a stamped row keeps its stamp whatever its entry time, exit or close reason say", () => {
    // Opened under blend-k100, closed by the k150 MODEL_CUTOVER pass: still k100.
    expect(rowModelVersion("momentum_stocks", { strategy_version: "momentum_stocks@blend-k100", entry_time: T("2026-10-12T13:36:35Z") }))
      .toBe("momentum_stocks@blend-k100");
  });

  test("unversioned sleeves and rows without an entry time resolve to null, never a guess", () => {
    expect(rowModelVersion("shadow_carry", { strategy_version: "legacy", entry_time: 1 })).toBeNull();
    expect(rowModelVersion("momentum_stocks", { strategy_version: "legacy", entry_time: null })).toBeNull();
    expect(currentModelVersionId("shadow_carry")).toBeNull();
  });
});

describe("insertTrade stamps every new row with the sleeve's version", () => {
  beforeEach(() => { makeTestDb(); });

  test("every live sleeve account gets its CURRENT version id — never 'legacy'", () => {
    for (const sleeve of ALL_PROFILE_IDS) {
      seedOpenTrade(`t-${sleeve}`, sleeve);
      const stamped = versionOf(`t-${sleeve}`);
      expect(stamped).toBe(MODEL_VERSIONS[sleeve][MODEL_VERSIONS[sleeve].length - 1].id);
      expect(stamped).not.toBe("legacy");
    }
  });

  test("an explicit strategyVersion wins; adoption rows stay ops_sync; non-sleeve accounts keep 'legacy'", () => {
    seedOpenTrade("explicit", "momentum_stocks", { strategyVersion: "momentum_stocks@blend-k100" });
    expect(versionOf("explicit")).toBe("momentum_stocks@blend-k100");
    seedOpenTrade("adopted", "momentum_crypto", { strategy: "SYNC_RECOVERY", market: "crypto" });
    expect(versionOf("adopted")).toBe("ops_sync");
    seedOpenTrade("shadow", "shadow_momentum_crypto", { market: "crypto" });
    expect(versionOf("shadow")).toBe("legacy");
  });

  test("closing a row — MODEL_CUTOVER included — never rewrites its version; the re-opened row carries the new one", () => {
    // The 2026-10-12 shape: a k100 row closed by the k150 cutover pass, the same
    // symbol re-bought in the same tick.
    seedOpenTrade("old-meta", "momentum_stocks", { symbol: "META", strategyVersion: "momentum_stocks@blend-k100" });
    closeTrade("old-meta", 120, Date.now(), 0, 500);
    updateTradeCloseReason("old-meta", "MODEL_CUTOVER");
    seedOpenTrade("new-meta", "momentum_stocks", { symbol: "META" });

    const current = currentModelVersionId("momentum_stocks")!;
    expect(current).not.toBe("momentum_stocks@blend-k100");
    expect(versionOf("old-meta")).toBe("momentum_stocks@blend-k100");
    expect(versionOf("new-meta")).toBe(current);
    const rows = getDB().prepare(`SELECT id, strategy_version, status, pnl, close_reason, entry_time, exit_time FROM trades ORDER BY id`).all() as any[];
    const rec = computeVersionRecords("momentum_stocks", rows);
    expect(rec.find(r => r.versionId === "momentum_stocks@blend-k100")).toMatchObject({ nOpened: 1, nClosed: 1, realizedPnl: 500 });
    expect(rec.find(r => r.versionId === current)).toMatchObject({ nOpened: 1, nOpen: 1, realizedPnl: 0 });
  });
});

describe("scorecard: the model window judges one version", () => {
  const CRYPTO = SCORECARD_ENTITIES.find(e => e.id === "momentum_crypto")!;
  const day = (o: number) =>
    new Date(Date.parse(MODEL_START.momentum_crypto + "T12:00:00Z") + o * 86_400_000).toISOString().slice(0, 10);
  const marks: DailyMark[] = [-1, 0, 1, 2].map((o, i) => ({
    dateKey: day(o), equity: 1000 + i * 10, snapshotTime: Date.parse(`${day(o)}T21:00:00Z`),
  }));
  const now = Date.parse(`${day(3)}T12:00:00Z`);
  const inWindow = Date.parse(`${day(1)}T10:00:00Z`);
  const row = (version: string, pnl: number, entry = T("2026-09-01T00:00:00Z")) => ({
    entry_price: 10, quantity: 1, entry_time: entry, exit_time: inWindow, status: "closed", pnl,
    strategy_version: version,
  });

  test("another version's closes (a cutover windfall) stay out of realized P&L; 30d keeps every row", () => {
    const trades = [
      row("momentum_crypto@vt35", 1000),          // opened by the previous model, closed inside the window
      row("momentum_crypto@vt35-corroff-mh120-nobrakes", 7, T("2026-10-29T00:00:00Z")),
    ];
    const model = computeWindowMetrics(CRYPTO, "model", marks, trades, null, now);
    expect(model.realizedPnl).toBe(7);
    expect(model.unrealizedPnl!).toBeCloseTo((1030 - 1000) - 7, 10); // equity move (base = prior close) − own realized

    const month = computeWindowMetrics(CRYPTO, "30d", marks, trades, null, now);
    expect(month.realizedPnl).toBe(1007);
  });

  test("legacy rows are attributed by entry time inside the model window as well", () => {
    const trades = [
      row("legacy", 1000, T("2026-10-01T00:00:00Z")),  // opened under vt35 (brake on)
      row("legacy", 5, T("2026-10-28T14:00:00Z")),     // opened under RW7 without a stamp
    ];
    const model = computeWindowMetrics(CRYPTO, "model", marks, trades, null, now);
    expect(model.realizedPnl).toBe(5);
  });
});
