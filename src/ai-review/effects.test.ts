import { describe, expect, test } from "bun:test";
import { COST_BP_PER_SIDE, buildLedger, nextSessionOf, renderLedger, signedUsd, usd, type JournalPass } from "./effects";

const eff = (symbol: string, action: "reduce" | "exit", modelWeight: number, appliedWeight: number) => ({ symbol, action, factor: appliedWeight / modelWeight, modelWeight, appliedWeight });
const review = (applied: boolean, ...effects: ReturnType<typeof eff>[]) => ({ aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied, effects } });
const pass = (sleeve: string, session: string, diagnostics: unknown = {}, equity = 10_000, status = "submitted"): JournalPass => ({ sleeve, session, status, equity, diagnostics });
const opens = (table: Record<string, number>) => (symbol: string, session: string) => table[`${symbol}@${session}`] ?? null;

describe("the effect of one day-action", () => {
  test("an exit that saves money: (applied − model) × equity × (next open ÷ open − 1)", () => {
    const l = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-17"),
    ], opens({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95 }));
    const e = l.applied.episodes[0];
    expect(e.days[0]).toMatchObject({ session: "2026-11-16", nextSession: "2026-11-17", open: 100, nextOpen: 95, equity: 10_000 });
    expect(e.days[0].returnPct).toBeCloseTo(-0.05, 12);
    expect(e.days[0].effectUsd).toBeCloseTo(-0.2 * 10_000 * -0.05, 9); // +100: the loss it avoided
    expect(e.savedUsd).toBeCloseTo(100, 9);
    expect(e.missedUsd).toBe(0);
  });

  test("an exit that costs: the stock rose, the effect is negative", () => {
    const l = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("AAPL", "exit", 0.1, 0))),
      pass("momentum_stocks", "2026-11-17"),
    ], opens({ "AAPL@2026-11-16": 200, "AAPL@2026-11-17": 210 }));
    const e = l.applied.episodes[0];
    expect(e.effectUsd).toBeCloseTo(-50, 9);
    expect(e.missedUsd).toBeCloseTo(50, 9);
    expect(e.savedUsd).toBe(0);
    expect(e.netUsd).toBeCloseTo(-50 - 2, 9); // plus its two costs
  });

  test("a reduce counts half of the weight: (0.025 − 0.05) × 10 000 × −4 % = +10", () => {
    const l = buildLedger([
      pass("meanrev_stocks", "2026-11-16", review(true, eff("JPM", "reduce", 0.05, 0.025))),
      pass("meanrev_stocks", "2026-11-17"),
    ], opens({ "JPM@2026-11-16": 250, "JPM@2026-11-17": 240 }));
    expect(l.applied.episodes[0].effectUsd).toBeCloseTo(10, 9);
    expect(l.applied.episodes[0].action).toBe("reduce");
  });

  test("the pass's own sleeve equity is the base, whatever the sleeve", () => {
    const l = buildLedger([
      pass("meanrev_stocks", "2026-11-16", review(true, eff("JPM", "exit", 0.05, 0)), 20_000),
      pass("meanrev_stocks", "2026-11-17", {}, 20_000),
    ], opens({ "JPM@2026-11-16": 100, "JPM@2026-11-17": 90 }));
    expect(l.applied.episodes[0].effectUsd).toBeCloseTo(0.05 * 20_000 * 0.1, 9);
  });

  test("pending: the next open is not in the data yet — no money, still a case; also a missing own open", () => {
    const l = buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0)))], opens({ "NVDA@2026-11-16": 100 }));
    const e = l.applied.episodes[0];
    expect(e.days[0]).toMatchObject({ nextOpen: null, returnPct: null, effectUsd: null });
    expect(e).toMatchObject({ pendingDays: 1, effectUsd: 0, savedUsd: 0, missedUsd: 0, endSession: null });
    expect(l.applied).toMatchObject({ cases: 1, pendingCases: 1, decisions: 1 });
    const none = buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0)))], opens({}));
    expect(none.applied.episodes[0].pendingDays).toBe(1);
  });
});

describe("costs: 10 bp per side on |Δweight| × equity, once when an override starts and once when it ends", () => {
  const px = opens({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 100, "NVDA@2026-11-18": 100, "NVDA@2026-11-19": 100 });
  test("the rate is the pre-registered 10 bp", () => expect(COST_BP_PER_SIDE).toBe(10));
  test("a one-day episode pays both; a three-day episode pays the same two, not three", () => {
    const one = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-17"),
    ], px).applied.episodes[0];
    expect(one).toMatchObject({ startCostUsd: 2, endCostUsd: 2, costUsd: 4, endSession: "2026-11-17", endedBy: "model" });
    const three = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-17", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-18", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-19"),
    ], px).applied.episodes[0];
    expect(three.days).toHaveLength(3);
    expect(three).toMatchObject({ startCostUsd: 2, endCostUsd: 2, costUsd: 4, startSession: "2026-11-16", lastSession: "2026-11-18", endSession: "2026-11-19" });
    expect(three.effectUsd).toBeCloseTo(0, 9);
    expect(three.netUsd).toBeCloseTo(-4, 9);
  });
  test("an episode still going has paid only its start; the end is charged on the equity of the day the weight came back", () => {
    const ongoing = buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-17", review(true, eff("NVDA", "exit", 0.2, 0)))], px).applied.episodes[0];
    expect(ongoing).toMatchObject({ startCostUsd: 2, endCostUsd: 0, costUsd: 2, endSession: null, endedBy: null });
    const ended = buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-17", {}, 12_000)], px).applied.episodes[0];
    expect(ended.endCostUsd).toBeCloseTo(0.001 * 0.2 * 12_000, 9);
  });
  test("a reduce costs on its own |Δweight|", () => {
    const e = buildLedger([pass("meanrev_stocks", "2026-11-16", review(true, eff("JPM", "reduce", 0.05, 0.025))), pass("meanrev_stocks", "2026-11-17")],
      opens({ "JPM@2026-11-16": 1, "JPM@2026-11-17": 1 })).applied.episodes[0];
    expect(e.startCostUsd).toBeCloseTo(0.25, 12);
    expect(e.endCostUsd).toBeCloseTo(0.25, 12);
  });
  test("the same name again after a gap is a second episode with its own two costs", () => {
    const l = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-17"),
      pass("momentum_stocks", "2026-11-18", review(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-19"),
    ], px);
    expect(l.applied.episodes).toHaveLength(2);
    expect(l.applied.costUsd).toBeCloseTo(8, 9);
  });
});

describe("applied and hypothetical are two ledgers, never added", () => {
  const px = opens({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 90, "NVDA@2026-11-19": 90, "AAPL@2026-11-16": 100, "AAPL@2026-11-17": 90 });
  const passes = [
    pass("momentum_stocks", "2026-11-16", review(false, eff("NVDA", "exit", 0.2, 0), eff("AAPL", "exit", 0.1, 0))), // informing
    pass("momentum_stocks", "2026-11-17", review(true, eff("NVDA", "exit", 0.2, 0))),                              // the switch went ON
    pass("momentum_stocks", "2026-11-18", review(true, eff("NVDA", "exit", 0.2, 0))),
    pass("momentum_stocks", "2026-11-19"),
  ];
  test("each ledger has its own episodes and totals", () => {
    const l = buildLedger(passes, px);
    expect(l.applied.episodes.map(e => [e.symbol, e.days.map(d => d.session)])).toEqual([["NVDA", ["2026-11-17", "2026-11-18"]]]);
    expect(l.hypothetical.episodes.map(e => [e.symbol, e.days.map(d => d.session)])).toEqual([["AAPL", ["2026-11-16"]], ["NVDA", ["2026-11-16"]]]);
    expect(l.applied.netUsd).not.toBe(l.hypothetical.netUsd);
    expect(l.applied.cases).toBe(2);
    expect(l.hypothetical.cases).toBe(2);
  });
  test("an informing episode that ends because the switch went ON pays no end cost (its sale is the applied episode's start)", () => {
    const l = buildLedger(passes, px);
    const hypo = l.hypothetical.episodes.find(e => e.symbol === "NVDA")!;
    expect(hypo).toMatchObject({ endedBy: "switch", endCostUsd: 0, startCostUsd: 2 });
    expect(l.hypothetical.episodes.find(e => e.symbol === "AAPL")).toMatchObject({ endedBy: "model", endCostUsd: 1 });
    expect(l.applied.episodes[0]).toMatchObject({ startSession: "2026-11-17", startCostUsd: 2, endCostUsd: 2, endedBy: "model" });
  });
  test("an applied episode that ends because the kill switch turned the mode to informing still pays its end (the bot really bought back)", () => {
    const l = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-17", review(false, eff("NVDA", "exit", 0.2, 0))),
    ], px);
    expect(l.applied.episodes[0]).toMatchObject({ endedBy: "switch", endCostUsd: 2 });
  });
});

describe("what is read from the journal", () => {
  test("only completed live stock passes count; failed, stale and malformed records read as nothing; one pass per session", () => {
    const px = opens({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95 });
    const l = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0)), 10_000, "failed"),
      pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0)), 10_000, "skipped_stale"),
      pass("momentum_crypto", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-16", { aiReview: { applied: "yes" } }),
      pass("momentum_stocks", "2026-11-16", null),
    ], px);
    expect(l.applied.decisions).toBe(0);
    expect(l.hypothetical.decisions).toBe(0);
  });
  test("a pass without a review ends the episode only when it is in the journal (a missing pass is not an end)", () => {
    const l = buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff("NVDA", "exit", 0.2, 0)))], opens({}));
    expect(l.applied.episodes[0].endSession).toBeNull();
  });
  test("nextSessionOf skips weekends and holidays", () => {
    expect(nextSessionOf("2026-11-13")).toBe("2026-11-16"); // Friday → Monday
    expect(nextSessionOf("2026-11-25")).toBe("2026-11-27"); // Thanksgiving in between
  });
});

describe("the words", () => {
  const eff1 = (s: string, a: "exit" | "reduce", m: number, ap: number) => eff(s, a, m, ap);
  const passes = [
    pass("momentum_stocks", "2026-11-16", review(true, eff1("NVDA", "exit", 0.2, 0), eff1("AAPL", "exit", 0.1, 0))),
    pass("momentum_stocks", "2026-11-17", review(true, eff1("NVDA", "exit", 0.2, 0))),
    pass("momentum_stocks", "2026-11-18"),
    pass("meanrev_stocks", "2026-11-16", review(true, eff1("JPM", "reduce", 0.05, 0.025))),
    pass("meanrev_stocks", "2026-11-17"),
  ];
  const px = opens({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 90, "AAPL@2026-11-16": 200, "AAPL@2026-11-17": 210, "JPM@2026-11-16": 250, "JPM@2026-11-17": 240 });

  test("the applied summary and one line per stock episode, verbatim", () => {
    expect(renderLedger(buildLedger(passes, px))).toBe([
      "La revisión de IA lleva 3 decisiones aplicadas en 2 días: evitó $215 de pérdidas y dejó de ganar $50; operar costó $7. Neto: +$158.",
      "• Apple (AAPL), Momentum Acciones: sacada el lunes 16 nov · dejó de ganar $50 · operar costó $2",
      "• Nvidia (NVDA), Momentum Acciones: sacada del lunes 16 nov al martes 17 nov (2 días) · evitó $205 de pérdidas · operar costó $4",
      "• JPMorgan (JPM), Reversión Acciones: reducida a la mitad el lunes 16 nov · evitó $10 de pérdidas · operar costó $1",
      "Para el veredicto hacen falta 20 casos (una acción cambiada en un día): van 4.",
    ].join("\n"));
  });

  test("nothing applied yet, and only hypothetical days: the hypothetical block is labelled and stays out of the verdict", () => {
    expect(renderLedger(buildLedger([], px))).toBe([
      "La revisión de IA todavía no ha cambiado ninguna orden.",
      "Para el veredicto hacen falta 20 casos (una acción cambiada en un día): van 0.",
    ].join("\n"));
    const hypo = buildLedger([
      pass("momentum_stocks", "2026-11-16", review(false, eff1("NVDA", "exit", 0.2, 0))),
      pass("momentum_stocks", "2026-11-17"),
    ], px);
    expect(renderLedger(hypo)).toBe([
      "La revisión de IA todavía no ha cambiado ninguna orden.",
      "Para el veredicto hacen falta 20 casos (una acción cambiada en un día): van 0.",
      "",
      "Lo que habría hecho mientras solo informaba (no cuenta para el veredicto)",
      "Habría aplicado 1 decisión en 1 día: habría evitado $100 de pérdidas y habría dejado de ganar $0; operar habría costado $4. Neto: +$96.",
      "• Nvidia (NVDA), Momentum Acciones: se habría sacado el lunes 16 nov · evitó $100 de pérdidas · operar costó $4",
    ].join("\n"));
  });

  test("a pending day is said as pending, never as money; an ongoing episode says it goes on", () => {
    const text = renderLedger(buildLedger([pass("momentum_stocks", "2026-11-16", review(true, eff1("NVDA", "exit", 0.2, 0)))], opens({ "NVDA@2026-11-16": 100 })));
    expect(text).toBe([
      "La revisión de IA lleva 1 decisión aplicada en 1 día; todavía no hay precios para medir el efecto.",
      "• Nvidia (NVDA), Momentum Acciones: sacada desde el lunes 16 nov (sigue, 1 día) · resultado pendiente · operar costó $2",
      "Faltan 1 caso por medir: esperan la apertura del día siguiente.",
      "Para el veredicto hacen falta 20 casos (una acción cambiada en un día): va 1.",
    ].join("\n"));
  });

  test("whole dollars with a real minus sign; under a dollar is '<$1'; no cents, no codes", () => {
    expect(usd(310.4)).toBe("$310");
    expect(usd(0.2)).toBe("<$1");
    expect(usd(12_345)).toBe("$12,345");
    expect(signedUsd(215.4)).toBe("+$215");
    expect(signedUsd(-40.6)).toBe("−$41");
    expect(signedUsd(0.2)).toBe("$0");
    const text = renderLedger(buildLedger(passes, px));
    for (const banned of [/\$\d+\.\d\d/, /_/, /\bsleeve\b/i, /\bnotional\b/i, /AI_REVIEW/]) expect(text).not.toMatch(banned);
  });
});
