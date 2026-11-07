// ── broker-modal.js — WHY-paused sleeve detail (2026-09-24) ────────────────
// Item 1 of the dashboard audit: a "paused" sleeve must show cause, current
// DD vs soft/hard thresholds, resume ETA, utilization, and realized vs
// unrealized P&L — never a bare "PAUSA" chip. These are the pure rendering
// helpers; the async fetch wiring lives in openBrokerModal (DOM-only, not
// unit-tested here).
import { describe, expect, test } from "bun:test";
import { riskDetailHtml, unrealizedPnlBySleeve, pauseCause, venueLabel } from "./broker-modal.js";
import { store } from "../store.js";

describe("unrealizedPnlBySleeve", () => {
  test("sums unrealizedPnl per profileId, skipping unpriced/unknown rows", () => {
    const out = unrealizedPnlBySleeve([
      { profileId: "momentum_crypto", unrealizedPnl: 10 },
      { profileId: "momentum_crypto", unrealizedPnl: -3 },
      { profileId: "momentum_stocks", unrealizedPnl: 5 },
      { profileId: "momentum_stocks", unrealizedPnl: null }, // unpriced — excluded, not counted as 0
      { profileId: null, unrealizedPnl: 100 }, // no sleeve attribution — excluded
    ]);
    expect(out.get("momentum_crypto")).toBe(7);
    expect(out.get("momentum_stocks")).toBe(5);
    expect(out.has(undefined)).toBe(false);
  });

  test("empty/missing positions -> empty map", () => {
    expect(unrealizedPnlBySleeve([]).size).toBe(0);
    expect(unrealizedPnlBySleeve(undefined).size).toBe(0);
  });
});

describe("riskDetailHtml — the sleeve detail block", () => {
  test("before the risk fetch lands (risk=null): exposure + unrealized only, whole dollars", () => {
    const html = riskDetailHtml({ id: "momentum_crypto", paused: true }, { ratio: 0.92, cap: 1.15, usage: 0.8 }, 42, null);
    expect(html).toContain("0.92× of 1.15×");
    expect(html).toContain("+$42");
    expect(html).not.toContain("$42.00");
    expect(html).not.toContain("Below peak");
  });

  test("a levered sleeve at its design size is not an alarm: red only past its own cap", () => {
    const atDesign = riskDetailHtml({ id: "momentum_stocks" }, { ratio: 1.5, cap: 2.5, usage: 0.6 }, null, null);
    expect(atDesign).toContain("1.50× of 2.5×");
    expect(atDesign).not.toContain("var(--down)");
    const past = riskDetailHtml({ id: "momentum_stocks" }, { ratio: 2.7, cap: 2.5, usage: 1.08 }, null, null);
    expect(past).toContain("var(--down)");
  });

  test("unknown exposure (COIN-M) reads a dash", () => {
    expect(riskDetailHtml({ id: "momentum_btc" }, { ratio: null }, null, null)).toContain("<b>—</b>");
  });

  test("paused sleeve: cause in words (the engine sentence is never printed), resume ETA, whole-dollar realized", () => {
    const risk = {
      mode: "paused", reason: "soft drawdown 12.3% — paused 24h", resumeAt: Date.now() + 3 * 3_600_000,
      realizedPnl: -340.5, drawdown: { currentPct: 0.123, softPct: null, hardPct: null },
    };
    const html = riskDetailHtml({ id: "momentum_crypto", paused: true }, { ratio: 0.5 }, -12, risk);
    expect(html).not.toContain("soft drawdown 12.3%");
    expect(html).toContain("Drawdown control");
    expect(html).toMatch(/resumes in.*[23]h/);
    expect(html).toContain("−$340");
    expect(html).toContain("−$12");
    expect(html).toContain("12.3%"); // the measure
  });

  test("drawdown is a measure: no soft/hard thresholds, no alarm colour, whatever the server sends", () => {
    const risk = { mode: "live", reason: "", resumeAt: 0, realizedPnl: 900, drawdown: { currentPct: 0.25, softPct: 0.10, hardPct: 0.20 } };
    const html = riskDetailHtml({ id: "momentum_stocks", paused: false }, null, 300, risk);
    expect(html).toContain("25.0%");
    for (const word of ["soft", "hard", "DD"]) expect(html).not.toContain(word);
    expect(html).not.toContain("var(--down)");
    expect(html).not.toContain("resumes in");
  });

  test("drawdown unavailable (null: portfolio-engine sleeve) is a dash, never a number", () => {
    const risk = { mode: "live", reason: "", resumeAt: 0, realizedPnl: 100, drawdown: { currentPct: null, softPct: null, hardPct: null } };
    const html = riskDetailHtml({ id: "momentum_stocks", paused: false }, null, null, risk);
    expect(html).toMatch(/Below peak <b>—<\/b>/);
  });

  test("Spanish UI", () => {
    store.set({ lang: "es" });
    const html = riskDetailHtml({ id: "x", paused: false }, null, 5, { realizedPnl: 1, drawdown: { currentPct: 0.1 } });
    expect(html).toContain("Bajo máximo");
    expect(html).toContain("Realizado");
    store.set({ lang: "en" });
  });
});

describe("pauseCause / venueLabel", () => {
  test("known causes are words; unknown prose is dropped", () => {
    expect(pauseCause("hard drawdown 21%")).toBe("drawdown limit");
    expect(pauseCause("5 consecutive losses")).toBe("several losses in a row");
    expect(pauseCause("something odd")).toBe("");
  });
  test("venues are names, not engine ids", () => {
    expect(venueLabel("binance_coinm")).toBe("Binance COIN-M");
    expect(venueLabel("alpaca")).toBe("Alpaca");
  });
});
