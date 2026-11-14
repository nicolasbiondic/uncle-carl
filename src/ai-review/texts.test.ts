import { describe, expect, test } from "bun:test";
import { sealDecision, type Override } from "./contract";
import { VERBS, companyLabel, opsFailure, opsNoDecision, opsShipped, ownerMessage, sessionLabel } from "./texts";
import { baseDecision } from "./testFixtures";

const nvda: Override = {
  sleeve: "momentum_stocks", symbol: "NVDA", action: "exit", factor: 0, meanConfidence: 0.8,
  votes: [{ family: "claude", action: "exit", confidence: 0.85 }, { family: "gpt", action: "exit", confidence: 0.75 }],
  reason: "El directorio prepara la salida del director ejecutivo tras el escándalo.",
  sources: ["https://www.cnbc.com/2026/11/11/nvidia.html", "https://www.reuters.com/x", "https://cnbc.com/other"],
};

describe("the owner's Telegram message", () => {
  test("with an action: verbatim", () => {
    const d = sealDecision(baseDecision({ overrides: [nvda], reviewed: 43 }));
    expect(ownerMessage(d)).toBe([
      "🧠 Revisión de IA · lunes 16 nov",
      "Sacaría Nvidia (NVDA) de Momentum Acciones: El directorio prepara la salida del director ejecutivo tras el escándalo. 2 de 3 modelos, confianza 80 %.",
      "Fuentes: cnbc.com, reuters.com",
      "Las otras 42 acciones, sin cambios.",
      "Por ahora solo informa: todavía no cambia las órdenes.",
    ].join("\n"));
  });
  test("without actions: verbatim, one line", () => {
    expect(ownerMessage(sealDecision(baseDecision()))).toBe("🧠 Revisión de IA · lunes 16 nov: sin cambios en las 43 acciones (3 de 3 modelos).");
  });
  test("without actions and only two models answered, it says so", () => {
    const d = sealDecision(baseDecision({ models: baseDecision().models.map((m, i) => (i === 2 ? { ...m, ok: false, error: "cuota" } : m)) }));
    expect(ownerMessage(d)).toBe("🧠 Revisión de IA · lunes 16 nov: sin cambios en las 43 acciones (solo respondieron 2 de 3 modelos).");
  });
  test("singular and plural of the others", () => {
    expect(ownerMessage(sealDecision(baseDecision({ overrides: [nvda], reviewed: 2 })))).toContain("\nLa otra acción, sin cambios.\n");
    expect(ownerMessage(sealDecision(baseDecision({ overrides: [nvda], reviewed: 1 })))).not.toContain("sin cambios");
    expect(ownerMessage(sealDecision(baseDecision({ overrides: [nvda], reviewed: 3 })))).toContain("Las otras 2 acciones, sin cambios.");
    expect(ownerMessage(sealDecision(baseDecision({ reviewed: 1 })))).toBe("🧠 Revisión de IA · lunes 16 nov: sin cambios en la acción (3 de 3 modelos).");
  });
  test("reduce and short use their own verbs; short explains itself; the strategy has its owner-facing name", () => {
    const red = ownerMessage(sealDecision(baseDecision({ overrides: [{ ...nvda, action: "reduce", factor: 0.5, sleeve: "meanrev_stocks", symbol: "JPM", meanConfidence: 0.65, votes: [...nvda.votes, { family: "gemini", action: "reduce", confidence: 0.4 }] }] })));
    expect(red).toContain("Reduciría a la mitad JPMorgan (JPM) en Reversión Acciones: ");
    expect(red).toContain("3 de 3 modelos, confianza 65 %.");
    const sh = ownerMessage(sealDecision(baseDecision({ overrides: [{ ...nvda, action: "short" }] })));
    expect(sh).toContain("Pondría en corto Nvidia (NVDA) en Momentum Acciones (gana si el precio baja): ");
  });
  test("several actions: one block each, separated by a blank line", () => {
    const m = ownerMessage(sealDecision(baseDecision({ overrides: [nvda, { ...nvda, symbol: "AAPL", action: "reduce", factor: 0.5 }], reviewed: 43 })));
    expect(m).toContain("Sacaría Nvidia (NVDA)");
    expect(m).toContain("\n\nReduciría a la mitad Apple (AAPL)");
    expect(m).toContain("Las otras 41 acciones, sin cambios.");
  });
  test("a reason that already ends in a full stop does not get two", () => {
    expect(ownerMessage(sealDecision(baseDecision({ overrides: [{ ...nvda, reason: "Algo pasó..." }] })))).toContain("Algo pasó. 2 de 3");
  });
  test("a strategy the bot acts on speaks in the present (the message leaves at 08:20, the bot acts at 09:35) and has no 'only informs' footer", () => {
    const d = sealDecision(baseDecision({ stage: "apply", overrides: [nvda], reviewed: 43 }));
    expect(ownerMessage(d, { momentum_stocks: true, meanrev_stocks: false })).toBe([
      "🧠 Revisión de IA · lunes 16 nov",
      "Hoy saca Nvidia (NVDA) de Momentum Acciones: El directorio prepara la salida del director ejecutivo tras el escándalo. 2 de 3 modelos, confianza 80 %.",
      "Fuentes: cnbc.com, reuters.com",
      "Las otras 42 acciones, sin cambios.",
    ].join("\n"));
    expect(VERBS.exit.apply.verb).toBe("Hoy saca");
    expect(VERBS.reduce.apply.verb).toBe("Hoy reduce a la mitad");
  });
  test("reduce and short in the present; a short is only taken out for now, and the message says so", () => {
    const both = { momentum_stocks: true, meanrev_stocks: true };
    const red = ownerMessage(sealDecision(baseDecision({ overrides: [{ ...nvda, action: "reduce", factor: 0.5, sleeve: "meanrev_stocks", symbol: "JPM", meanConfidence: 0.65 }] })), both);
    expect(red).toContain("Hoy reduce a la mitad JPMorgan (JPM) en Reversión Acciones: ");
    expect(red).not.toContain("solo informa");
    const sh = ownerMessage(sealDecision(baseDecision({ overrides: [{ ...nvda, action: "short" }] })), both);
    expect(sh).toContain("Hoy saca Nvidia (NVDA) de Momentum Acciones (pedían ponerla en corto; por ahora solo se saca): ");
    expect(sh).not.toContain("Pondría");
  });
  test("mixed (one strategy acts, the other informs): each block in its own tense, and the footer names the strategy that only informs", () => {
    const jpm: Override = { ...nvda, sleeve: "meanrev_stocks", symbol: "JPM", action: "reduce", factor: 0.5, reason: "Resultados débiles." };
    const d = sealDecision(baseDecision({ stage: "apply", overrides: [nvda, jpm], reviewed: 43 }));
    expect(ownerMessage(d, { momentum_stocks: true, meanrev_stocks: false })).toBe([
      "🧠 Revisión de IA · lunes 16 nov",
      "Hoy saca Nvidia (NVDA) de Momentum Acciones: El directorio prepara la salida del director ejecutivo tras el escándalo. 2 de 3 modelos, confianza 80 %.",
      "Fuentes: cnbc.com, reuters.com",
      "",
      "Reduciría a la mitad JPMorgan (JPM) en Reversión Acciones: Resultados débiles. 2 de 3 modelos, confianza 80 %.",
      "Fuentes: cnbc.com, reuters.com",
      "Las otras 41 acciones, sin cambios.",
      "Reversión Acciones por ahora solo informa: todavía no cambia sus órdenes.",
    ].join("\n"));
    // the other way round
    const m = ownerMessage(d, { momentum_stocks: false, meanrev_stocks: true });
    expect(m).toContain("Sacaría Nvidia (NVDA) de Momentum Acciones");
    expect(m).toContain("Hoy reduce a la mitad JPMorgan (JPM) en Reversión Acciones");
    expect(m.endsWith("Momentum Acciones por ahora solo informa: todavía no cambia sus órdenes.")).toBe(true);
  });
  test("a strategy that applies but has nothing in the message adds no footer; one that informs alone keeps the stage-A footer verbatim", () => {
    const onlyMomentum = ownerMessage(sealDecision(baseDecision({ overrides: [nvda] })), { momentum_stocks: true, meanrev_stocks: false });
    expect(onlyMomentum).not.toContain("solo informa");
    const informOnly = ownerMessage(sealDecision(baseDecision({ overrides: [nvda] })), { momentum_stocks: false, meanrev_stocks: true });
    expect(informOnly.endsWith("Por ahora solo informa: todavía no cambia las órdenes.")).toBe(true);
    expect(informOnly).toContain("Sacaría Nvidia (NVDA)");
  });
  test("no actions, no tense: the one-line message is the same whatever applies", () => {
    const d = sealDecision(baseDecision());
    expect(ownerMessage(d, { momentum_stocks: true, meanrev_stocks: true })).toBe(ownerMessage(d));
  });
  test("plain words: a name on every ticker, no jargon, no cents, no 'quórum'", () => {
    expect(companyLabel("USD")).toBe("Semiconductores ×2 (USD)");
    expect(companyLabel("ZZZZ")).toBe("ZZZZ");
    expect(sessionLabel("2026-11-17")).toBe("martes 17 nov");
    const text = ownerMessage(sealDecision(baseDecision({ overrides: [nvda, { ...nvda, symbol: "AAPL", action: "short" }] })));
    for (const banned of [/quórum/i, /quorum/i, /\bsleeve\b/i, /\bfills?\b/i, /\bMtM\b/i, /\bdisplay\b/i, /\bnotional\b/i, /\$\d+\.\d\d/, /\d×/]) expect(text).not.toMatch(banned);
  });
});

describe("OPS messages (technical words)", () => {
  test("no decision names every model and why", () => {
    const m = opsNoDecision("2026-11-16", [{ model: "a/b", ok: true, error: null }, { model: "c/d", ok: false, error: "timed out after 720 s" }], ["cuotas-ia failed"]);
    expect(m).toContain("SIN decisión");
    expect(m).toContain("1 veredicto(s) válido(s)");
    expect(m).toContain("c/d falló (timed out after 720 s)");
    expect(m).toContain("Sigue vigente la anterior");
  });
  test("a failure says which step and that the previous decision stays", () => {
    expect(opsFailure("2026-11-16", "el envío", "scp exited 1")).toContain("sigue vigente la anterior");
  });
  test("a shipped decision lists notes and warnings", () => {
    const d = sealDecision(baseDecision({ overrides: [nvda] }));
    const m = opsShipped(d, ["deadline reached"], ["pre-market unavailable"]);
    expect(m).toContain(d.id);
    expect(m).toContain("1 cambio(s) de 43 acciones");
    expect(m).toContain("Aviso: deadline reached; pre-market unavailable");
  });
});
