// What the owner reads (Telegram, one message per run) and what OPS reads. Owner text follows the project skill
// texto-para-personas: plain Spanish, the company's name with its ticker, whole percentages, the strategies by
// their owner-facing names, no jargon ("2 de 3 modelos", never "quórum"). The verbs live in ONE table: a strategy the bot
// acts on reads "Hoy saca …", one that only informs reads "Sacaría …". Enforced: src/ai-review/texts.test.ts (verbatim).

import { betOutcome } from "./bets";
import { SLEEVE_NAMES, type Decision, type Override, type OverrideAction, type SleeveId } from "./contract";
import { BET_MAX_USD } from "./limits";
import { PANEL_SIZE } from "./models";
// @ts-ignore shared owner-facing names, plain JS also used by the dashboard.
import { symbolName } from "../dashboard/public/v4/js/symbol-names.js";

/** `inform`: the bot changes no order for this strategy. `apply`: stage B, the bot acts today (09:35 New York; the message
 *  leaves at 08:20, so it speaks in the present). */
export type Tense = "inform" | "apply";

/** Which strategies the bot acts on, as the dev side reads the same switch (src/ai-review/apply.ts). */
export type Applies = Readonly<Record<SleeveId, boolean>>;
export const ALL_INFORM: Applies = { momentum_stocks: false, meanrev_stocks: false };

export const VERBS: Readonly<Record<OverrideAction, Readonly<Record<Tense, { verb: string; prep: string; note?: string }>>>> = {
  exit: { inform: { verb: "Sacaría", prep: "de" }, apply: { verb: "Hoy saca", prep: "de" } },
  reduce: { inform: { verb: "Reduciría a la mitad", prep: "en" }, apply: { verb: "Hoy reduce a la mitad", prep: "en" } },
  short: {
    inform: { verb: "Pondría en corto", prep: "en", note: "gana si el precio baja" },
    // With the bets switch OFF the bot takes the name out and says so; with it ON (since 2026-11-14) the message says "Hoy apuesta contra …"
    // (a bet) or why the short is only an exit (NO_BET_NOTES), by `betOutcome`.
    apply: { verb: "Hoy saca", prep: "de", note: "pedían ponerla en corto; por ahora solo se saca" },
  },
};

export const FOOTER_INFORM = "Por ahora solo informa: todavía no cambia las órdenes.";
/** Mixed (one strategy acts, the other only informs): the footer names the one that only informs. */
export const footerFor = (informing: readonly SleeveId[], mixed: boolean): string | null =>
  informing.length === 0 ? null : mixed ? `${informing.map(s => SLEEVE_NAMES[s]).join(" y ")} por ahora solo informa: todavía no cambia sus órdenes.` : FOOTER_INFORM;

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-16" → "lunes 16 nov". */
export function sessionLabel(session: string): string {
  const d = new Date(`${session}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Nvidia (NVDA)": a plain name on every ticker; the bare ticker only when no name exists. */
export function companyLabel(symbol: string): string {
  const name = symbolName(symbol, "es");
  return name ? `${name} (${symbol})` : symbol;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const noFinalDot = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** Models that gave a valid answer. */
export const answered = (d: Decision): number => d.models.filter(m => m.ok).length;

/** Stage C: why a `short` that the bot could have bet on is only taken out, in plain words (the verb stays "Hoy saca"). */
export const NO_BET_NOTES = {
  no_fund: "pedían ponerla en corto, pero no hay un fondo que suba cuando baje; solo se saca",
  cap: "pedían ponerla en corto, pero ya hay dos apuestas con más confianza; solo se saca",
} as const;

/** "$2,500": the bet's ceiling in whole dollars, from the pre-registered constant. */
const betCeiling = `$${BET_MAX_USD.toLocaleString("en-US")}`;

function actionBlock(o: Override, tense: Tense, outcome: ReturnType<typeof betOutcome> = null): string {
  const hosts = [...new Set(o.sources.map(hostOf))];
  const tail = `${noFinalDot(o.reason)}. ${o.votes.length} de ${PANEL_SIZE} modelos, confianza ${pct(o.meanConfidence)}.`;
  if (outcome === "bet") {
    // The strategy acts and the bets switch is on: the stock goes out AND the stock's inverse fund goes in. "hasta": never more than the model had in it.
    const plain = symbolName(o.symbol, "es") ?? o.symbol;
    return [
      `Hoy apuesta contra ${companyLabel(o.symbol)} en ${SLEEVE_NAMES[o.sleeve]}: la saca y pone hasta ${betCeiling} en un fondo que sube cuando ${plain} baja. ${tail}`,
      `Fuentes: ${hosts.join(", ")}`,
    ].join("\n");
  }
  const v = VERBS[o.action][tense];
  const note = outcome === "no_fund" || outcome === "cap" ? ` (${NO_BET_NOTES[outcome]})` : v.note ? ` (${v.note})` : "";
  return [
    `${v.verb} ${companyLabel(o.symbol)} ${v.prep} ${SLEEVE_NAMES[o.sleeve]}${note}: ${tail}`,
    `Fuentes: ${hosts.join(", ")}`,
  ].join("\n");
}

export function ownerMessage(d: Decision, applies: Applies = ALL_INFORM, betsOn = false): string {
  const head = `🧠 Revisión de IA · ${sessionLabel(d.session)}`;
  if (d.overrides.length === 0) {
    const n = answered(d);
    const stocks = d.reviewed === 1 ? "la acción" : `las ${d.reviewed} acciones`;
    const panel = n >= PANEL_SIZE ? `${n} de ${PANEL_SIZE} modelos` : `solo respondieron ${n} de ${PANEL_SIZE} modelos`;
    return `${head}: sin cambios en ${stocks} (${panel}).`;
  }
  const tenseOf = (o: Override): Tense => (applies[o.sleeve] ? "apply" : "inform");
  const others = d.reviewed - d.overrides.length;
  // The dev machine never guesses what the bot will do with a short: `betOutcome` is the SAME function the bot calls (src/ai-review/bets.ts),
  // fed with the bot's own switches that the case file carried (`applies`, `betsOn`).
  const lines = [head, d.overrides.map(o => actionBlock(o, tenseOf(o), betOutcome(d, o, { applies, betsOn }))).join("\n\n")];
  if (others === 1) lines.push("La otra acción, sin cambios.");
  else if (others > 1) lines.push(`Las otras ${others} acciones, sin cambios.`);
  const informing = [...new Set(d.overrides.filter(o => tenseOf(o) === "inform").map(o => o.sleeve))];
  const footer = footerFor(informing, d.overrides.some(o => tenseOf(o) === "apply"));
  if (footer) lines.push(footer);
  return lines.join("\n");
}

// ── OPS (technical words, one message per run) ───────────────────────────
function modelLine(d: { models: { model: string; ok: boolean; error: string | null }[] }): string {
  return d.models.map(m => `${m.model} ${m.ok ? "ok" : `falló (${m.error ?? "?"})`}`).join(" · ");
}

export function opsNoDecision(session: string, models: { model: string; ok: boolean; error: string | null }[], notes: string[]): string {
  const ok = models.filter(m => m.ok).length;
  return `🧠 revision-ia ${session}: SIN decisión (${ok} veredicto(s) válido(s), hacen falta 2 de familias distintas). Sigue vigente la anterior.\n${modelLine({ models })}${notes.length ? `\n${notes.join("; ")}` : ""}`;
}

export function opsFailure(session: string, step: string, detail: string): string {
  return `🧠 revision-ia ${session}: falló ${step}. No se envió decisión; sigue vigente la anterior.\n${detail.slice(0, 600)}`;
}

export function opsShipped(d: Decision, notes: string[], warnings: string[]): string {
  const extra = [...notes, ...warnings];
  return `🧠 revision-ia ${d.session}: decisión ${d.id} enviada (${d.overrides.length} cambio(s) de ${d.reviewed} acciones). ${modelLine(d)}${extra.length ? `\nAviso: ${extra.join("; ")}` : ""}`;
}
