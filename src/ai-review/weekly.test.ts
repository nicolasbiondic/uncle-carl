// The owner's weekly message: a week with decisions, a week without, the adjustments line, the attribution that makes the weeks add up,
// and the words (the ledger's own vocabulary, whole dollars, a plain name on every ticker). Verbatim, like texts.test.ts.
import { describe, expect, test } from "bun:test";
import { buildLedger, renderLedger, type JournalPass } from "./effects";
import { findMisses } from "./history";
import type { HeldPass } from "./journalDb";
import { AI_REVIEW_START, PANEL_FAILURE_RUNS, adjustmentsLine, digestRuns, onlyPanelChanged, parseAdjustments, parseLedgerJson, weekLabel, weekOf, weekSlice, weeklyMessage, type AdjustmentEntry } from "./weekly";

const eff = (symbol: string, action: "reduce" | "exit", modelWeight: number, appliedWeight: number) => ({ symbol, action, factor: appliedWeight / modelWeight, modelWeight, appliedWeight });
const rev = (...effects: ReturnType<typeof eff>[]) => ({ aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied: true, effects } });
const pass = (sleeve: string, session: string, held: string[], diagnostics: unknown = {}): HeldPass => ({ sleeve, session, status: "submitted", equity: 10_000, diagnostics, held });

const PRICES: Record<string, number> = {
  "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 96, "NVDA@2026-11-18": 92, "NVDA@2026-11-19": 90,
  "AAPL@2026-11-17": 200, "AAPL@2026-11-18": 210,
  "JPM@2026-11-18": 250, "JPM@2026-11-19": 245, "JPM@2026-11-20": 240,
  "XOM@2026-11-19": 100, "XOM@2026-11-20": 103,
  "MSFT@2026-11-17": 400, "MSFT@2026-11-18": 375.2,
  "AMZN@2026-11-13": 40, "AMZN@2026-11-16": 37.84,
};
const opens = (symbol: string, session: string): number | null => {
  if (session >= "2026-11-23") return null;
  const own = Object.entries(PRICES).filter(([k]) => k.startsWith(`${symbol}@`)).map(([k, v]) => [k.split("@")[1], v] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (own.length === 0) return 100;
  return (own.filter(([d]) => d <= session).at(-1) ?? own[0])[1];
};
const UNIVERSES = { momentum_stocks: ["NVDA", "AAPL", "MSFT", "AMZN"], meanrev_stocks: ["JPM", "XOM", "KO"] };

const PASSES: HeldPass[] = [
  pass("momentum_stocks", "2026-11-13", ["AMZN"]),
  pass("momentum_stocks", "2026-11-16", ["NVDA", "AAPL", "MSFT", "AMZN"], rev(eff("NVDA", "exit", 0.2, 0))),
  pass("momentum_stocks", "2026-11-17", ["AAPL", "MSFT", "AMZN"], rev(eff("NVDA", "exit", 0.2, 0), eff("AAPL", "exit", 0.1, 0))),
  pass("momentum_stocks", "2026-11-18", ["MSFT", "AMZN"], rev(eff("NVDA", "exit", 0.2, 0))),
  pass("momentum_stocks", "2026-11-19", ["MSFT"]),
  pass("momentum_stocks", "2026-11-20", ["MSFT"]),
  pass("meanrev_stocks", "2026-11-18", ["JPM", "XOM", "KO"], rev(eff("JPM", "reduce", 0.05, 0.025))),
  pass("meanrev_stocks", "2026-11-19", ["JPM", "XOM", "KO"], rev(eff("JPM", "reduce", 0.05, 0.025), eff("XOM", "exit", 0.04, 0))),
  pass("meanrev_stocks", "2026-11-20", ["JPM", "KO"], rev(eff("KO", "exit", 0.03, 0))),
];

/** What `bun scripts/ai-review-report.ts --json` prints, through the real parser. */
function data(passes: HeldPass[] = PASSES) {
  const ledger = buildLedger(passes as JournalPass[], opens);
  const text = JSON.stringify({ generatedAt: "2026-11-21T14:30:00.000Z", ...ledger, misses: findMisses(passes, opens, UNIVERSES) });
  const parsed = parseLedgerJson(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ledger, ...parsed.value };
}

const WEEK = { start: "2026-11-16", end: "2026-11-20" };
const entry = (date: string, kind: "change" | "none", forOwner: string | null, title = kind === "change" ? "Cambio: algo" : "Sin cambios"): AdjustmentEntry => ({ date, kind, title, forOwner });

describe("the week", () => {
  test("it is the most recent Monday-to-Friday week that ended before today (Saturday: the week that just ended)", () => {
    expect(weekOf("2026-11-21")).toEqual(WEEK);   // Saturday
    expect(weekOf("2026-11-22")).toEqual(WEEK);   // Sunday
    expect(weekOf("2026-11-23")).toEqual(WEEK);   // Monday: the week before
    expect(weekOf("2026-11-20")).toEqual({ start: "2026-11-09", end: "2026-11-13" }); // Friday itself is not finished
  });
  test("its label, inside a month and across two", () => {
    expect(weekLabel(WEEK)).toBe("semana del 16 al 20 nov");
    expect(weekLabel({ start: "2026-11-30", end: "2026-12-04" })).toBe("semana del 30 nov al 4 dic");
  });
});

describe("a week with decisions", () => {
  test("the message, verbatim: the ledger's words, one line per decision, the falls it did not see, since the start, the adjustments", () => {
    const d = data();
    expect(weeklyMessage({ data: d, week: WEEK, adjustments: [entry("2026-11-21", "none", "Aún hay pocos casos para ajustar con seguridad.")], agent: { kind: "ok" } })).toBe([
      "🧠 Revisión de IA · semana del 16 al 20 nov",
      "Tomó 4 decisiones: evitó $217 de pérdidas y dejó de ganar $62; operar costó $7. Neto: +$148.",
      "Sacó Nvidia (NVDA) 3 días: evitó $207.",
      "Sacó Apple (AAPL) 1 día: dejó de ganar $50.",
      "Redujo a la mitad JPMorgan (JPM) 2 días: evitó $10.",
      "Sacó Exxon Mobil (XOM) 1 día: dejó de ganar $12.",
      "Lo del viernes se mide el lunes.",
      "No vio 2 caídas fuertes: Amazon (AMZN) −5,4 % el viernes 13 nov; Microsoft (MSFT) −6,2 % el martes.",
      "Desde el inicio (16 nov): neto +$147.",
      "Ajustes de esta semana: ninguno. Aún hay pocos casos para ajustar con seguridad.",
    ].join("\n"));
  });

  test("the figures are the ledger's: same verbs and the same net rule as renderLedger", () => {
    const d = data();
    const text = renderLedger({ applied: d.applied, hypothetical: { ...d.applied, episodes: [], decisions: 0, cases: 0, pendingCases: 0, sessions: 0, savedUsd: 0, missedUsd: 0, costUsd: 0, netUsd: 0 } });
    for (const phrase of ["evitó $217 de pérdidas y dejó de ganar $62", "operar costó $8"]) expect(text).toContain(phrase);
    expect(text).toContain("Neto: +$147.");
    const msg = weeklyMessage({ data: d, week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(msg).toContain("Desde el inicio (16 nov): neto +$147.");
    expect(msg).toContain("evitó $217 de pérdidas y dejó de ganar $62; operar costó $7. Neto: +$148.");
  });

  test("the weeks add up: what is counted in a week is what was measured in it, so two weeks together are the whole ledger", () => {
    const d = data();
    const next = { start: "2026-11-23", end: "2026-11-27" };
    // Monday's open arrives: Friday's exit is measured in the NEXT week, with its start cost
    const later = (symbol: string, session: string) => (symbol === "KO" && session === "2026-11-23" ? 97 : opens(symbol, session === "2026-11-23" && symbol !== "KO" ? "2026-11-20" : session));
    const passes = [...PASSES, pass("meanrev_stocks", "2026-11-23", ["JPM"])];
    const ledger = buildLedger(passes as JournalPass[], later);
    const a = weekSlice(ledger.applied, WEEK), b = weekSlice(ledger.applied, next);
    expect(a.fridayPending).toBe(false);
    expect(a.block.decisions).toBe(4);
    expect(b.block.decisions).toBe(1);
    expect(b.episodes[0]).toMatchObject({ symbol: "KO" });
    expect(a.block.netUsd + b.block.netUsd).toBeCloseTo(ledger.applied.netUsd, 9);
    expect(a.block.costUsd + b.block.costUsd).toBeCloseTo(ledger.applied.costUsd, 9);
    expect(a.block.savedUsd + b.block.savedUsd).toBeCloseTo(ledger.applied.savedUsd, 9);
    expect(d.applied.cases).toBe(ledger.applied.cases);
  });

  test("an episode that is still on says so; a measured loss or gain keeps the ledger's verbs; a day without a price reads pending", () => {
    const passes = [pass("momentum_stocks", "2026-11-17", ["NVDA"], rev(eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", "2026-11-18", ["NVDA"], rev(eff("NVDA", "exit", 0.2, 0)))];
    const msg = weeklyMessage({ data: data(passes), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(msg).toContain("Sacó Nvidia (NVDA) 2 días (sigue): evitó $");
    const gap = (s: string, d: string) => (s === "NVDA" && d === "2026-11-19" ? null : opens(s, d));
    const ledger = buildLedger(passes as JournalPass[], gap);
    const slice = weekSlice(ledger.applied, WEEK);
    expect(slice.episodes[0].pendingDays).toBe(1);
  });
});

describe("a week without decisions", () => {
  test("says so in one line, keeps the falls line and the rest", () => {
    const quiet = [pass("momentum_stocks", "2026-11-17", ["MSFT"]), pass("momentum_stocks", "2026-11-18", ["MSFT"])];
    const d = data(quiet);
    expect(weeklyMessage({ data: d, week: WEEK, adjustments: [], agent: { kind: "ok" } }).split("\n").slice(0, 4)).toEqual([
      "🧠 Revisión de IA · semana del 16 al 20 nov",
      "Esta semana la revisión no tomó ninguna decisión.",
      "No vio 1 caída fuerte: Microsoft (MSFT) −6,2 % el martes.",
      "Desde el inicio (16 nov): todavía ninguna decisión.",
    ]);
  });
  test("no decision and no fall: the complete message", () => {
    const d = data([pass("momentum_stocks", "2026-11-17", ["JPM"])]);
    expect(weeklyMessage({ data: d, week: WEEK, adjustments: [], agent: { kind: "ok" } })).toBe([
      "🧠 Revisión de IA · semana del 16 al 20 nov",
      "Esta semana la revisión no tomó ninguna decisión.",
      "No vio ninguna caída fuerte.",
      "Desde el inicio (16 nov): todavía ninguna decisión.",
      "Ajustes de esta semana: no quedó anotada la revisión de esta semana.",
    ].join("\n"));
  });
  test("a ledger that could not be read is said, never a zero", () => {
    expect(weeklyMessage({ data: null, week: WEEK, adjustments: [], agent: { kind: "skipped", reason: "la cuota de Claude está al 91 %" } })).toBe([
      "🧠 Revisión de IA · semana del 16 al 20 nov",
      "No se pudieron leer los resultados de la revisión esta semana.",
      "Ajustes de esta semana: no se pudo revisar (la cuota de Claude está al 91 %).",
    ].join("\n"));
  });
  test("only Friday's decision, not measured yet: no 'decisions' line with a zero, but the Friday line", () => {
    const d = data([pass("meanrev_stocks", "2026-11-20", ["KO"], rev(eff("KO", "exit", 0.03, 0)))]);
    const msg = weeklyMessage({ data: d, week: WEEK, adjustments: [], agent: { kind: "ok" } }).split("\n");
    expect(msg[1]).toBe("Esta semana la revisión no tomó ninguna decisión.");
    expect(msg[2]).toBe("Lo del viernes se mide el lunes.");
    expect(msg.some(l => l.startsWith("Desde el inicio (16 nov): todavía sin precios para medir"))).toBe(true);
  });
});

describe("the adjustments line", () => {
  test("none: the plain word; a 'sin cambios' entry adds its own reason", () => {
    expect(adjustmentsLine([], { kind: "ok" })).toBe("Ajustes de esta semana: no quedó anotada la revisión de esta semana.");
    expect(adjustmentsLine([entry("2026-11-21", "none", null)], { kind: "ok" })).toBe("Ajustes de esta semana: ninguno.");
    expect(adjustmentsLine([entry("2026-11-21", "none", "Faltan casos")], { kind: "ok" })).toBe("Ajustes de esta semana: ninguno. Faltan casos.");
  });
  test("a change: its one plain sentence; several: one bullet each", () => {
    expect(adjustmentsLine([entry("2026-11-21", "change", "Se pidió más pruebas antes de sacar una acción.")], { kind: "ok" })).toBe("Ajustes de esta semana: Se pidió más pruebas antes de sacar una acción.");
    expect(adjustmentsLine([entry("2026-11-18", "change", "Uno."), entry("2026-11-21", "change", "Dos")], { kind: "ok" })).toBe("Ajustes de esta semana:\n• Uno.\n• Dos.");
    expect(adjustmentsLine([entry("2026-11-21", "change", null, "Cambio: el panel")], { kind: "ok" })).toBe("Ajustes de esta semana: hubo un cambio (el panel).");
  });
  test("skipped or failed says why; a run that went outside what it may touch goes to a person", () => {
    expect(adjustmentsLine([], { kind: "failed", reason: "el agente terminó con error." })).toBe("Ajustes de esta semana: no se pudo revisar (el agente terminó con error).");
    expect(adjustmentsLine([entry("2026-11-21", "change", "x")], { kind: "violated" })).toContain("los revisará una persona");
  });
  test("an adjustment the launcher could not publish: pinned verbatim, and the entry's own sentence is NOT quoted (it never reached the released log)", () => {
    const line = "Ajustes de esta semana: la revisión se hizo, pero no se pudo publicar; lo revisa una persona.";
    expect(adjustmentsLine([], { kind: "unpublished" })).toBe(line);
    expect(adjustmentsLine([entry("2026-11-21", "change", "Una frase que no salió.")], { kind: "unpublished" })).toBe(line);
    const msg = weeklyMessage({ data: data(), week: WEEK, adjustments: [], agent: { kind: "unpublished" } });
    expect(msg.split("\n").at(-1)).toBe(line);
    expect(msg.split("\n")[0]).toBe("🧠 Revisión de IA · semana del 16 al 20 nov");
  });
});

describe("the log's entries", () => {
  const md = [
    "# Ajustes de la revisión de IA", "texto de cabecera", "",
    "## 2026-11-14 · Cambio: el interruptor queda encendido", "- **Qué cambió:** el bot actúa.", "- **Para el dueño:** La revisión ya opera desde el primer día.", "",
    "## 2026-11-21 · Sin cambios: pocos casos", "- **Evidencia:** 2 casos.", "- **Para el dueño:** Todavía hay pocos casos para ajustar.", "",
    "## 2026-11-28 · Propuesta: subir el tamaño", "Para el dueño: Una idea para ti.", "",
  ].join("\n");
  test("date, kind (only 'Cambio' changes something) and the owner's sentence", () => {
    expect(parseAdjustments(md)).toEqual([
      { date: "2026-11-14", kind: "change", title: "Cambio: el interruptor queda encendido", forOwner: "La revisión ya opera desde el primer día." },
      { date: "2026-11-21", kind: "none", title: "Sin cambios: pocos casos", forOwner: "Todavía hay pocos casos para ajustar." },
      { date: "2026-11-28", kind: "none", title: "Propuesta: subir el tamaño", forOwner: "Una idea para ti." },
    ]);
    expect(parseAdjustments("")).toEqual([]);
    expect(parseAdjustments("# nada\n## sin fecha\n")).toEqual([]);
  });
  test("the real log parses and its first entries are dated 2026-11-14", async () => {
    const real = parseAdjustments(await Bun.file(new URL("../../docs/reports/IA-ajustes.md", import.meta.url)).text().catch(() => ""));
    if (real.length === 0) return; // a fork has no log
    expect(real[0].date).toBe("2026-11-14");
    expect(real.every(e => e.forOwner !== null)).toBe(true);
  });
});

describe("the ledger JSON is checked before it is trusted", () => {
  test("refuses what is not the report, keeps what is", () => {
    expect(parseLedgerJson("nope").ok).toBe(false);
    expect(parseLedgerJson("{}").ok).toBe(false);
    expect(parseLedgerJson(JSON.stringify({ applied: { episodes: [{}] } })).ok).toBe(false);
    const d = data();
    expect(d.applied.decisions).toBe(5);
    expect(d.misses.map(m => m.symbol).sort()).toEqual(["AMZN", "MSFT"]);
    expect(AI_REVIEW_START).toBe("2026-11-16");
  });
  test("the owner text has no code words, no cents, no 'x' notation", () => {
    const msg = weeklyMessage({ data: data(), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    for (const banned of ["fills", "MtM", "sleeve", "notional", "quórum", "×"]) expect(msg).not.toContain(banned);
    expect(msg).not.toMatch(/\$\d+\.\d\d/);
  });
});

describe("what the weekly agent is shown about the models (counted by code)", () => {
  const rec = (models: Array<[string, string, boolean, string | null, boolean]>, verdicts: Array<[string, Record<string, string>]> = []) => ({
    models: models.map(([model, family, ok, error, searched]) => ({ model, family, ok, error, searched })),
    verdicts: verdicts.map(([family, v]) => ({ family, verdict: { session: "x", verdicts: Object.fromEntries(Object.entries(v).map(([sym, action]) => [sym, { action, confidence: 0.8, reason: "r", sources: [] }])) } })),
  });
  test("failures, skipped (a closed quota is not the model's fault), searches and the non-keep verdicts per model", () => {
    const records = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"].map((session, i) => ({
      session,
      record: rec([
        ["codex/gpt-6.1-sol", "gpt", i === 3, i === 3 ? null : "OpenCode exited 1: boom", i === 3],
        ["anthropic/claude-sonnet-5-5", "claude", i !== 1, i === 1 ? "Claude quota closed (semanal 91 %)" : null, true],
        ["antigravity/gemini-3.8-flash-high", "gemini", true, null, false],
      ], [["claude", { NVDA: "exit", AAPL: "reduce" }], ["gemini", {}], ...(i === 3 ? [["gpt", { NVDA: "exit" }] as [string, Record<string, string>]] : [])]),
    }));
    const d = digestRuns(records);
    expect(d.sessions).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    const by = Object.fromEntries(d.models.map(m => [m.model, m]));
    expect(by["codex/gpt-6.1-sol"]).toMatchObject({ runs: 4, failures: 3, skipped: 0, searched: 1, failedInThreeOrMore: true, errors: ["OpenCode exited 1: boom"], verdicts: { exit: 1, reduce: 0, short: 0 } });
    expect(by["anthropic/claude-sonnet-5-5"]).toMatchObject({ runs: 4, failures: 0, skipped: 1, searched: 4, failedInThreeOrMore: false, verdicts: { exit: 3, reduce: 3, short: 0 } });
    expect(by["antigravity/gemini-3.8-flash-high"]).toMatchObject({ failures: 0, failedInThreeOrMore: false });
    expect(PANEL_FAILURE_RUNS).toBe(3);
    expect(d.runsWithoutDecision).toBe(0); // every run had at least two valid verdicts
  });
  test("an unreadable or empty record is skipped, never a crash", () => {
    expect(digestRuns([])).toEqual({ sessions: [], runsWithoutDecision: 0, models: [] });
    expect(digestRuns([{ session: "2026-11-16", record: null }, { session: "2026-11-17", record: { models: "x", verdicts: 3 } }]).models).toEqual([]);
  });
});

describe("the one file of src/ the agent may edit: the panel", () => {
  const models = require("node:fs").readFileSync(new URL("./models.ts", import.meta.url), "utf8") as string;
  test("the real file is its own baseline; swapping a primary, adding a substitute and a family entry is a panel change", () => {
    expect(onlyPanelChanged(models, models)).toBe(true);
    const swapped = models.replace('"antigravity/gemini-3.8-flash-high",\n];', '"opencode-go/glm-5.5",\n];');
    expect(swapped).not.toBe(models);
    expect(onlyPanelChanged(models, swapped)).toBe(true);
    const more = models.replace('"opencode/deepseek-v4.1-flash-free",\n];', '"opencode/deepseek-v4.1-flash-free",\n  "opencode-go/glm-5.5",\n];').replace('  "opencode-go/qwen3.8-max": {', '  "opencode-go/glm-5.5": { family: "glm", pool: null },\n  "opencode-go/qwen3.8-max": {');
    expect(more).not.toBe(models);
    expect(onlyPanelChanged(models, more)).toBe(true);
  });
  test("a threshold, the panel size, the gate, a new export or a comment elsewhere is NOT a panel change", () => {
    for (const [from, to] of [["CLOSE_5H = 80", "CLOSE_5H = 95"], ["PANEL_SIZE = 3", "PANEL_SIZE = 2"], ["CLOSE_WEEK = 85", "CLOSE_WEEK = 99"], ["if (info.pool === null)", "if (info.pool === null || true)"], ["export const familyOf", "// tuned\nexport const familyOf"]]) {
      const edited = models.replace(from, to);
      expect(edited).not.toBe(models);
      expect(onlyPanelChanged(models, edited)).toBe(false);
    }
    expect(onlyPanelChanged(models, models + "\nexport const EXTRA = 1;\n")).toBe(false);
    expect(onlyPanelChanged(models, models.replace("export const PRIMARIES", "export const PRIMARIES_X"))).toBe(false); // a block that disappears is not a panel edit
    expect(onlyPanelChanged(models, "")).toBe(false);
  });
});
