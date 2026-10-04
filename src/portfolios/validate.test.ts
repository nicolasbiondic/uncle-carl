// ═══════════════════════════════════════════════════════════════════════
// F3d — portfolio write validation (pure). Platform invariants as tests:
// per-template schema + ranges, runtime accounts, capital > 0 with the
// account-sum ≤ equity rule, DISJOINT universes per account (AGENTS.md
// shared-wallet rule at write time), validated presets (manifest-locked
// against LIVE_SLEEVE_MANIFESTS) vs free templates (never validated),
// pending_restart lifecycle, owner-only archiving, and the unvalidated
// mark on any param edit of a validated portfolio.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ACCOUNT_EQUITY_SEMANTICS,
  VALIDATED_PRESETS,
  presetParamsFor,
  validateCreatePortfolio,
  validatePatchPortfolio,
} from "./validate";
import { initPlatformPortfolios, loadPlatformPortfolioRows, type PlatformPortfolioRow } from "./store";
import { LIVE_SLEEVE_MANIFESTS } from "../config/liveSleeveConfigs";
import { EQUITY_SEMANTICS } from "../strategies/momentum/RiskGuard";
import type { MomentumTsmParams } from "./types";

const NOW = Date.UTC(2026, 9, 4, 12);
const ACCOUNTS = ["alpaca_main", "binance_usdt", "binance_usdc", "binance_coinm"];
const EQUITY: Record<string, number> = { alpaca_main: 110_000, binance_usdt: 6_000, binance_usdc: 6_000, binance_coinm: 2_000 };

function seededRows(mutate?: (rows: PlatformPortfolioRow[]) => void): PlatformPortfolioRow[] {
  const db = new Database(":memory:");
  initPlatformPortfolios(db);
  const rows = loadPlatformPortfolioRows(db);
  mutate?.(rows);
  return rows;
}

function ctx(rows: PlatformPortfolioRow[], equity: Record<string, number | null> = EQUITY) {
  return { existing: rows, accounts: ACCOUNTS, accountEquity: (a: string) => equity[a] ?? null };
}

describe("VALIDATED_PRESETS — the four live sleeves, manifest-locked", () => {
  test("mirrors LIVE_SLEEVE_MANIFESTS exactly (vivo = validado)", () => {
    expect(Object.fromEntries(Object.entries(VALIDATED_PRESETS).map(([k, v]) => [k, v.manifestPath]))).toEqual({ ...LIVE_SLEEVE_MANIFESTS });
  });
  test("account ↔ equity-semantics map covers the four runtime accounts", () => {
    expect(ACCOUNT_EQUITY_SEMANTICS.alpaca_main).toBe(EQUITY_SEMANTICS.SLEEVE_LEDGER);
    expect(ACCOUNT_EQUITY_SEMANTICS.binance_usdt).toBe(EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN);
    expect(ACCOUNT_EQUITY_SEMANTICS.binance_usdc).toBe(EQUITY_SEMANTICS.BINANCE_USDC_MARGIN);
    expect(ACCOUNT_EQUITY_SEMANTICS.binance_coinm).toBe(EQUITY_SEMANTICS.BINANCE_COINM_MARGIN);
  });
});

describe("create from a validated preset", () => {
  const archivedCrypto = () => seededRows((rows) => {
    const r = rows.find((x) => x.id === "momentum_crypto")!;
    r.status = "archived";
    r.enabled = false;
  });

  test("owner replaces an archived sleeve: validated, pending_restart, identity params regenerated, no cutover copied", () => {
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 5_000, preset: "momentum_crypto" },
      ctx(archivedCrypto()), NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.validation).toBe("validated");
    expect(out.row.status).toBe("pending_restart"); // applies on NEXT boot
    expect(out.row.source).toBe("owner");
    expect(out.row.mode).toBe("live");
    const p = out.row.params as MomentumTsmParams;
    expect(p.state.path).toBe("data/momentum-state-momentum_crypto_v2.json");
    expect(p.state.currentBase).toBe(5_000);
    expect(p.heartbeatName).toBe("momentum:momentum_crypto_v2");
    expect(p.loggerContext).toBe("Momentum:momentum_crypto_v2");
    expect((p as any).cutover).toBeUndefined(); // one-shots never copy
    // Strategy params stay byte-identical to the validated sleeve.
    expect(p.volTarget).toEqual({ annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 });
    expect(p.notionalPctPerSlot).toBe(0.375);
  });

  test("ANY param override on a preset leaves the artifact behind → unvalidated", () => {
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 5_000, preset: "momentum_crypto", params: { notionalPctPerSlot: 0.3 } },
      ctx(archivedCrypto()), NOW,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.row.validation).toBe("unvalidated");
  });

  test("unknown preset is rejected with the valid list", () => {
    const out = validateCreatePortfolio(
      { id: "x_momentum", name: "X", account: "binance_usdt", capital: 1_000, preset: "momentum_btc" },
      ctx(seededRows()), NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("not a validated preset");
  });
});

describe("cross-portfolio invariants (the money rules)", () => {
  test("universe must be DISJOINT from the account's other ENABLED portfolios", () => {
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 500, preset: "momentum_crypto" },
      ctx(seededRows()), NOW, // momentum_crypto still enabled → full overlap
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const msg = out.errors.join(" ");
      expect(msg).toContain("universe overlaps enabled portfolio 'momentum_crypto'");
      expect(msg).toContain("BTC/USD");
    }
  });

  test("overlap with a DISABLED portfolio is allowed (the rule binds enabled books only)", () => {
    const rows = seededRows((r) => {
      const c = r.find((x) => x.id === "momentum_crypto")!;
      c.enabled = false;
    });
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 500, preset: "momentum_crypto" },
      ctx(rows), NOW,
    );
    expect(out.ok).toBe(true);
  });

  test("sum of the account's enabled capitals must fit its equity", () => {
    const rows = seededRows((r) => { r.find((x) => x.id === "momentum_crypto")!.enabled = false; });
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 7_000, preset: "momentum_crypto" },
      ctx(rows), NOW, // equity binance_usdt = 6_000
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("> account equity");
  });

  test("unreadable account equity FAILS CLOSED (an edit is never time-critical)", () => {
    const rows = seededRows((r) => { r.find((x) => x.id === "momentum_crypto")!.enabled = false; });
    const out = validateCreatePortfolio(
      { id: "momentum_crypto_v2", name: "Crypto v2", account: "binance_usdt", capital: 500, preset: "momentum_crypto" },
      ctx(rows, { ...EQUITY, binance_usdt: null }), NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("equity is unreadable");
  });

  test("capital must be > 0; account must exist in the runtime; id must be unique and well-formed", () => {
    const rows = seededRows();
    const bad1 = validateCreatePortfolio({ id: "ok_id_x", name: "X", account: "binance_usdt", capital: 0, preset: "momentum_crypto" }, ctx(rows), NOW);
    expect(bad1.ok).toBe(false);
    const bad2 = validateCreatePortfolio({ id: "ok_id_x", name: "X", account: "kraken_main", capital: 100, preset: "momentum_crypto" }, ctx(rows), NOW);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.errors.join(" ")).toContain("not a runtime broker account");
    const bad3 = validateCreatePortfolio({ id: "momentum_crypto", name: "X", account: "binance_usdt", capital: 100, preset: "momentum_crypto" }, ctx(rows), NOW);
    expect(bad3.ok).toBe(false);
    if (!bad3.ok) expect(bad3.errors.join(" ")).toContain("already exists");
    const bad4 = validateCreatePortfolio({ id: "Bad-Id!", name: "X", account: "binance_usdt", capital: 100, preset: "momentum_crypto" }, ctx(rows), NOW);
    expect(bad4.ok).toBe(false);
  });
});

describe("free template — honest by construction", () => {
  const freeParams = (): MomentumTsmParams => ({
    ...(presetParamsFor("momentum_crypto", "free_mom", 1_000) as MomentumTsmParams),
    universe: ["BNB/USD"],
  });

  test("a schema-valid free template is accepted but NEVER validated", () => {
    const out = validateCreatePortfolio(
      { id: "free_mom", name: "Free momentum", account: "binance_usdt", capital: 1_000, template: "momentum_tsm", params: freeParams() },
      ctx(seededRows()), NOW,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.row.validation).toBe("unvalidated");
  });

  test("schema ranges bite: maxLongs, gross cap 2.0×, equity-semantics ↔ account, meanrev off-alpaca", () => {
    const base = { id: "free_mom", name: "F", account: "binance_usdt" as const, capital: 1_000, template: "momentum_tsm" as const };
    const r1 = validateCreatePortfolio({ ...base, params: { ...freeParams(), maxLongs: 50 } }, ctx(seededRows()), NOW);
    expect(r1.ok).toBe(false);
    const r2 = validateCreatePortfolio({ ...base, params: { ...freeParams(), maxLongs: 8, notionalPctPerSlot: 0.5 } }, ctx(seededRows()), NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join(" ")).toContain("≤ 2.0×");
    const r3 = validateCreatePortfolio({ ...base, params: { ...freeParams(), equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER } }, ctx(seededRows()), NOW);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.errors.join(" ")).toContain("equitySemantics");
    const r4 = validateCreatePortfolio(
      { id: "free_mr", name: "F", account: "binance_usdt", capital: 1_000, template: "meanrev_connors", params: presetParamsFor("meanrev_stocks", "free_mr", 1_000) },
      ctx(seededRows()), NOW,
    );
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.errors.join(" ")).toContain("alpaca_main");
    const r5 = validateCreatePortfolio({ ...base, params: { ...freeParams(), cutover: { at: 1, expiresAt: 2 } } as any }, ctx(seededRows()), NOW);
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.errors.join(" ")).toContain("cutover");
  });
});

describe("PATCH — pending_restart lifecycle, unvalidated mark, owner-only archive", () => {
  test("replacing params marks the row unvalidated and pending_restart", () => {
    const rows = seededRows();
    const stocks = rows.find((r) => r.id === "momentum_stocks")!;
    const newParams = { ...(stocks.params as MomentumTsmParams), volStop: { kSigma: 6, lookbackBars: 20, minPct: 4, maxPct: 25 } };
    const out = validatePatchPortfolio("momentum_stocks", { params: newParams }, ctx(rows), NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.validation).toBe("unvalidated"); // edited away from the artifact
    expect(out.row.status).toBe("pending_restart"); // applies on next boot
  });

  test("identical params keep the validated mark (no-op is a no-op)", () => {
    const rows = seededRows();
    const stocks = rows.find((r) => r.id === "momentum_stocks")!;
    const out = validatePatchPortfolio("momentum_stocks", { params: stocks.params }, ctx(rows), NOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.row.validation).toBe("validated");
      expect(out.row.status).toBe("active");
    }
  });

  test("a real edit makes the row the owner's (the boot seed stops refreshing it); a no-op keeps it builtin", () => {
    const edited = validatePatchPortfolio("meanrev_stocks", { capital: 55_000 }, ctx(seededRows()), NOW);
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.row.source).toBe("owner");
    const renamed = validatePatchPortfolio("momentum_stocks", { name: "Stocks (renamed)" }, ctx(seededRows()), NOW);
    if (renamed.ok) expect(renamed.row.source).toBe("owner");
    const rows = seededRows();
    const noop = validatePatchPortfolio("momentum_stocks", { params: rows.find((r) => r.id === "momentum_stocks")!.params }, ctx(rows), NOW);
    if (noop.ok) expect(noop.row.source).toBe("builtin");
  });

  test("name-only edits need no restart", () => {
    const out = validatePatchPortfolio("momentum_stocks", { name: "Stocks (renamed)" }, ctx(seededRows()), NOW);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.row.status).toBe("active");
  });

  test("capital edits re-check the account sum (shared Alpaca wallet)", () => {
    const out = validatePatchPortfolio("meanrev_stocks", { capital: 70_000 }, ctx(seededRows()), NOW);
    // 50k (momentum_stocks) + 70k > 110k equity → refused
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("> account equity");
    const ok = validatePatchPortfolio("meanrev_stocks", { capital: 55_000 }, ctx(seededRows()), NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.row.status).toBe("pending_restart");
  });

  test("archive/unarchive is an explicit owner flag; unknown id is a clean not-found", () => {
    const rows = seededRows();
    const out = validatePatchPortfolio("momentum_btc", { archived: true }, ctx(rows), NOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.row.status).toBe("archived");
      expect(out.row.enabled).toBe(false);
    }
    const missing = validatePatchPortfolio("nope", {}, ctx(rows), NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]).toContain("not found");
  });
});
