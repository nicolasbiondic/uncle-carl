// ══════════════════════════════════════════════
// The Agent tab, macro Market ribbon, legacy Algos matrix/toggles, and the
// Backtest tab (no live writer for backtest_results) were removed along with
// the backend endpoints they depended on (v8: /api/regime, /api/market-context,
// /api/derivatives, /api/breadth, /api/agent, /api/strategies/matrix,
// /api/strategies/:name/toggle no longer exist server-side).
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderAnalyticsShell } from "./analytics.js";
import { api } from "../api.js";

describe("dead analytics tabs are gone", () => {
  test("the tab strip only offers Equity / Performance / Activity", () => {
    store.set({ tab: "equity" });
    const html = renderAnalyticsShell();
    expect(html).toContain("data-atab=\"equity\"");
    expect(html).toContain("data-atab=\"performance\"");
    expect(html).toContain("data-atab=\"activity\"");
    expect(html).not.toContain("data-atab=\"agent\"");
    expect(html).not.toContain("data-atab=\"market\"");
    expect(html).not.toContain("data-atab=\"backtest\"");
    expect(html).not.toContain("data-atab=\"algos\"");
    expect(html).not.toContain(">Agent<");
    expect(html).not.toContain(">Backtest<");
    expect(html).not.toContain(">Algos<");
  });

  test("api.js no longer exposes callers for the removed backend endpoints", () => {
    for (const key of ["regime", "marketContext", "derivatives", "breadth", "events", "cot", "alerts", "agent", "scenario", "correlations", "strategiesMatrix", "toggleStrategy", "strategies", "riskMetrics", "backtestLatest"]) {
      expect(api[key]).toBeUndefined();
    }
  });
});
