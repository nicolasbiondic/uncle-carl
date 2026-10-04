// ── broker-modal.js — WHY-paused sleeve detail (2026-09-24) ────────────────
// Item 1 of the dashboard audit: a "paused" sleeve must show cause, current
// DD vs soft/hard thresholds, resume ETA, utilization, and realized vs
// unrealized P&L — never a bare "PAUSA" chip. These are the pure rendering
// helpers; the async fetch wiring lives in openBrokerModal (DOM-only, not
// unit-tested here).
import { describe, expect, test } from "bun:test";
import { riskDetailHtml, unrealizedPnlBySleeve } from "./broker-modal.js";

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

describe("riskDetailHtml — the WHY-paused block", () => {
  test("before the risk fetch lands (risk=null): shows utilization + unrealized only, no cause/DD", () => {
    const html = riskDetailHtml({ id: "momentum_crypto", paused: true }, { ratio: 0.92 }, 42, null);
    expect(html).toContain("92%");
    expect(html).toContain("$42.00");
    expect(html).not.toContain("soft");
    expect(html).not.toContain("hard");
  });

  test("paused sleeve with risk loaded: cause, DD vs soft/hard thresholds, resume ETA, realized P&L all present", () => {
    const resumeAt = Date.now() + 3 * 3_600_000; // 3h from now
    const risk = {
      mode: "paused",
      reason: "soft drawdown 12.3% — paused 24h",
      resumeAt,
      realizedPnl: -340.5,
      drawdown: { currentPct: 0.123, softPct: 0.10, hardPct: 0.20 },
    };
    const html = riskDetailHtml({ id: "momentum_crypto", paused: true }, { ratio: 0.5 }, -12, risk);
    expect(html).toContain("soft drawdown 12.3%"); // the cause, verbatim
    expect(html).toContain("12.3%"); // current DD
    expect(html).toContain("10% soft"); // soft threshold
    expect(html).toContain("20% hard"); // hard threshold
    expect(html).toContain("resumes in");
    expect(html).toMatch(/resumes in.*[23]h/); // ETA (~3h, clock-tolerant)
    expect(html).toContain("−$340.50"); // realized (unicode minus, fmt.js convention)
    expect(html).toContain("−$12.00"); // unrealized
  });

  test("a live (not paused) sleeve renders no cause line even if risk carries a stale pauseReason field", () => {
    const risk = { mode: "live", reason: "", resumeAt: 0, realizedPnl: 900, drawdown: { currentPct: 0.02, softPct: 0.10, hardPct: 0.20 } };
    const html = riskDetailHtml({ id: "momentum_stocks", paused: false }, null, 300, risk);
    expect(html).not.toContain("resumes in");
    expect(html).toContain("2.0%"); // still shows current DD proactively
  });

  test("DD unavailable (no persisted state file, e.g. this decommissioned checkout) never fabricates a number", () => {
    const risk = { mode: "live", reason: "", resumeAt: 0, realizedPnl: 100, drawdown: { currentPct: null, softPct: 0.10, hardPct: 0.20 } };
    const html = riskDetailHtml({ id: "momentum_stocks", paused: false }, null, null, risk);
    expect(html).not.toContain("DD <b");
  });
});
