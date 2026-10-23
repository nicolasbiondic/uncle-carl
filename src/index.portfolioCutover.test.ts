// Source locks for the portfolio-engine wiring in src/index.ts (main() cannot be booted in a test):
// the properties that make "exactly one engine per sleeve" true by construction.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { PORTFOLIO_SLEEVES } from "./portfolio-engine/live/cutover";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
const at = (needle: string, from = 0) => { const i = src.indexOf(needle, from); if (i < 0) throw new Error(`index.ts: '${needle}' not found`); return i; };

describe("index.ts: portfolio engine wiring", () => {
  test("every sleeve the portfolio engine may replace has its incumbent gated by portfolioEnabled()", () => {
    for (const sleeve of Object.keys(PORTFOLIO_SLEEVES)) {
      const gates = src.match(new RegExp(`(?:&& |!)portfolioEnabled\\("${sleeve}"\\)`, "g")) ?? [];
      expect({ sleeve, gates: gates.length >= 1 }).toEqual({ sleeve, gates: true });
    }
  });
  test("portfolioEnabled() is false for a cut-over sleeve BEFORE it looks at the registry flag", () => {
    const body = src.slice(at("function portfolioEnabled(id: string): boolean {"), at("function momentumPlanFor"));
    expect(body.indexOf("portfolioCutoverSleeves.has(id)")).toBeGreaterThan(-1);
    expect(body.indexOf("portfolioCutoverSleeves.has(id)")).toBeLessThan(body.indexOf("dbPortfolioDefs"));
  });
  test("order: engines constructed → cutover set → hand-back → incumbents built/started → two-manager guard → portfolio engines started → heartbeats", () => {
    const order = [
      "const peBuilt = buildPortfolioEngines(",
      "portfolioCutoverSleeves = new Set(peBuilt.live.keys())",
      "await restoreIncumbentRows(",
      "cryptoEngine = new MomentumEngine(",
      "const stocks = new MomentumEngine(",
      "const meanrevEngine = new MeanRevEngine(",
      "sleevesWithTwoManagers(peBuilt.live.keys()",
      "startPortfolioEngines(peEngines)",
      "heartbeats.start();",
    ].map(n => at(n));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the USDC incumbent too (its construction is gated on the same function)
    expect(at("usdcEngine = new MomentumEngine(")).toBeGreaterThan(at("await restoreIncumbentRows("));
  });
  test("the portfolio engines are stopped on shutdown", () => {
    expect(src).toContain("handles.stopPortfolioEngines?.();");
  });
  test("a cut-over sleeve is registered with the governor under its MODEL VERSION as evidence version (watchdog never blind; evidence restarts at the cutover; judged against its own band)", () => {
    const i = at("for (const sleeve of portfolioCutoverSleeves) {", at("const governor = new SleeveGovernor("));
    const block = src.slice(i, src.indexOf("}", src.indexOf("governor.register(", i)));
    expect(block).toContain('governor.register({ sleeve, kind: "live", evidenceVersion: currentModelVersionId(sleeve)');
    // Registered right after the governor exists and BEFORE any incumbent branch (which the cutover gates off).
    expect(i).toBeLessThan(at("cryptoEngine = new MomentumEngine("));
  });
  test("a boot that reads the registry marks its pending_restart rows active (the cutover script's definitions do not stay 'applies on the next restart' forever)", () => {
    const db = src.slice(at('if (portfoliosSource === "db") {'), at("} else {", at('if (portfoliosSource === "db") {')));
    expect(db).toContain("loadPlatformPortfolioDefinitions(getDB())");
    expect(db).toContain("markPendingPortfoliosActive(getDB())");
    expect(db.indexOf("loadPlatformPortfolioDefinitions")).toBeLessThan(db.indexOf("markPendingPortfoliosActive"));
  });
});
