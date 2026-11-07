// Source locks for the portfolio-engine wiring in src/index.ts (main() cannot be booted in a test):
// the properties that make "exactly one engine per sleeve" true by construction, and (since 2026-11-07)
// the stock sleeves' built-in fallback: no TSM/Connors incumbent exists, so a registry problem falls
// back to the code's definition of the same model and pages, and NO MANAGER pages on every boot.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { PORTFOLIO_SLEEVES } from "./portfolio-engine/live/cutover";
import { STOCK_SLEEVE_BUILTIN_DEFINITION } from "./portfolios/builtin";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
const at = (needle: string, from = 0) => { const i = src.indexOf(needle, from); if (i < 0) throw new Error(`index.ts: '${needle}' not found`); return i; };

describe("index.ts: portfolio engine wiring", () => {
  test("every CRYPTO sleeve the portfolio engine may replace has its incumbent gated by portfolioEnabled(); the stock sleeves have no incumbent to gate", () => {
    for (const sleeve of Object.keys(PORTFOLIO_SLEEVES)) {
      const gates = src.match(new RegExp(`(?:&& |!)portfolioEnabled\\("${sleeve}"\\)`, "g")) ?? [];
      const hasIncumbent = PORTFOLIO_SLEEVES[sleeve].incumbentStrategy !== null;
      expect({ sleeve, gates: gates.length >= 1 }).toEqual({ sleeve, gates: hasIncumbent });
    }
    expect(src).not.toContain("AlpacaMomentumAdapter");
    expect(src).not.toContain("new MeanRevEngine(");
  });
  test("stock sleeves: the built-in fallback runs when the registry gives no live engine; NO MANAGER pages unless the venue is simply unlinked", () => {
    const block = src.slice(at("// 8c. Stock sleeves run ONLY on the portfolio engine"), at("portfolioCutoverSleeves = new Set(peBuilt.live.keys())"));
    expect(block).toContain("for (const [sleeve, builtinId] of Object.entries(STOCK_SLEEVE_BUILTIN_DEFINITION))");
    expect(block).toContain("if (peBuilt.live.has(sleeve)) continue;");
    // venue unlinked (no account linked: a fresh install) → NO MANAGER as a WARNING, no fallback attempt
    expect(block).toContain('portfolioNotice("PortfolioCutover", `${sleeve}: NO MANAGER — alpaca venue UNLINKED');
    // registry source → the fallback itself pages (code source only logs: the built-in IS the source)
    expect(block).toContain("falling back to the code's built-in definition");
    expect(block).toContain("fallbackDefinitions(");
    expect(block).toContain("peBuilt.live.set(sleeve, engine);");
    // fallback could not run with the venue linked → NO MANAGER page naming G2
    expect(block).toContain('portfolioAlert("PortfolioCutover", `${sleeve}: NO MANAGER — the built-in fallback');
    expect(block).toContain("guardian G2");
    // one engine per sleeve: observers of a sleeve in fallback are not started
    expect(block).toContain("peBuilt.observers = peBuilt.observers.filter(e => e.accountId !== sleeve);");
    expect(Object.keys(STOCK_SLEEVE_BUILTIN_DEFINITION).sort()).toEqual(["meanrev_stocks", "momentum_stocks"]);
  });
  test("a definition refused only because its venue is unlinked is a warning; any other refusal pages", () => {
    const loop = src.slice(at("const venueUnlinked = (definitionId: string): boolean =>"), at("// 8c. Stock sleeves run ONLY on the portfolio engine"));
    expect(loop).toContain("(venueUnlinked(p.definitionId) ? portfolioNotice : portfolioAlert)(\"PortfolioCutover\"");
    const notice = src.slice(at("const portfolioNotice = (context: string, message: string) => {"), at("const peWiring_venueReady"));
    expect(notice).toContain("log.warn(");
    expect(notice).not.toContain("ERROR_BURST");
  });
  test("portfolioEnabled() is false for a cut-over sleeve BEFORE it looks at the registry flag", () => {
    const body = src.slice(at("function portfolioEnabled(id: string): boolean {"), at("function momentumPlanFor"));
    expect(body.indexOf("portfolioCutoverSleeves.has(id)")).toBeGreaterThan(-1);
    expect(body.indexOf("portfolioCutoverSleeves.has(id)")).toBeLessThan(body.indexOf("dbPortfolioDefs"));
  });
  test("order: engines constructed → stock fallback → cutover set → hand-back → crypto incumbents built/started → two-manager guard → portfolio engines started → heartbeats", () => {
    const order = [
      "const peBuilt = buildPortfolioEngines(",
      "// 8c. Stock sleeves run ONLY on the portfolio engine",
      "portfolioCutoverSleeves = new Set(peBuilt.live.keys())",
      "await restoreIncumbentRows(",
      "cryptoEngine = new MomentumEngine(",
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
    expect(block).toContain('governor.register({ sleeve, evidenceVersion: currentModelVersionId(sleeve)');
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
