// The owner's weekly reading of the AI review (amendment 2026-11-14 of docs/reports/IA-revision-de-noticias-2026-11-14.md, point 2).
// Deterministic, no model: the figures are the effect ledger's (src/ai-review/effects.ts, same words through `summaryAfter` and
// `resultWords`), cut to one Monday-to-Friday week, plus the strong falls the review did not see (src/ai-review/history.ts) and what the
// weekly adjustment wrote in docs/reports/IA-ajustes.md. Spanish, whole dollars, a plain name on every ticker (texto-para-personas).
// Pure: it reads nothing; scripts/ai-review-weekly.ts hands it the ledger JSON and the log's text. Enforced: src/ai-review/weekly.test.ts.
//
// Attribution (so the weeks add up to the figure "desde el inicio"): a day-action belongs to the week in which it was MEASURED, i.e. the
// week that contains the next session (its closing open); the cost of starting an override to the week of its first day's measure, the
// cost of ending it to the week of the session the model's weight came back. Friday's day-actions are measured on Monday and read
// "lo del viernes se mide el lunes" until then.

import { SLEEVE_IDS, type HistoryMiss, type OverrideAction, type SleeveId } from "./contract";
import { betResultWords, blockOf, netWhole, nextSessionOf, plural, resultWords, signedUsd, summaryAfter, type DayEffect, type Episode, type LedgerBlock } from "./effects";
import { companyLabel, sessionLabel } from "./texts";

/** The day the review began to act ("desde el inicio"): defined with the ledger (src/ai-review/effects.ts). */
export { AI_REVIEW_START } from "./effects";
import { AI_REVIEW_START } from "./effects";

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "2026-11-16" → "16 nov". */
export const dayShort = (date: string): string => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
/** "2026-11-17" → "martes". */
const weekdayOf = (date: string): string => sessionLabel(date).split(" ")[0];

export interface Week { start: string; end: string }

/** The Monday-to-Friday week the message is about: the most recent Friday strictly before `today`, and its Monday. */
export function weekOf(today: string): Week {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday … 6 = Saturday
  const back = ((dow - 5 + 7) % 7) || 7;
  const end = addDays(today, -back);
  return { start: addDays(end, -4), end };
}

/** "semana del 16 al 20 nov", or "semana del 30 nov al 4 dic" across two months. */
export function weekLabel(w: Week): string {
  return w.start.slice(5, 7) === w.end.slice(5, 7)
    ? `semana del ${Number(w.start.slice(8, 10))} al ${dayShort(w.end)}`
    : `semana del ${dayShort(w.start)} al ${dayShort(w.end)}`;
}

// ── the ledger as prod prints it (--json), checked before it is trusted ──────────────────────────
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isDate = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

function episodeOk(e: any): e is Episode {
  return e && (SLEEVE_IDS as readonly string[]).includes(e.sleeve) && typeof e.symbol === "string" && ["exit", "short", "reduce"].includes(e.action)
    && (e.kind === undefined || e.kind === "bet")
    && isDate(e.startSession) && isDate(e.lastSession) && (e.endSession === null || isDate(e.endSession))
    && isNum(e.startCostUsd) && isNum(e.endCostUsd) && Array.isArray(e.days) && e.days.length > 0
    && e.days.every((d: any) => d && isDate(d.session) && isDate(d.nextSession) && (d.effectUsd === null || isNum(d.effectUsd)));
}

export interface WeeklyData { applied: LedgerBlock; misses: HistoryMiss[] }

/** `bun scripts/ai-review-report.ts --json` → the applied ledger and the misses; an error string when it is not that. */
export function parseLedgerJson(text: string): { ok: true; value: WeeklyData } | { ok: false; error: string } {
  let j: any;
  try { j = JSON.parse(text); } catch { return { ok: false, error: "the report is not JSON" }; }
  const a = j?.applied;
  if (!a || !Array.isArray(a.episodes) || !a.episodes.every(episodeOk)) return { ok: false, error: "the report has no usable applied ledger" };
  for (const k of ["decisions", "sessions", "cases", "pendingCases", "savedUsd", "missedUsd", "costUsd", "netUsd"]) if (!isNum(a[k])) return { ok: false, error: `the report's applied.${k} is not a number` };
  if (a.betUsd !== undefined && !isNum(a.betUsd)) return { ok: false, error: "the report's applied.betUsd is not a number" };
  const misses: HistoryMiss[] = [];
  for (const m of Array.isArray(j.misses) ? j.misses : []) {
    if (m && isDate(m.session) && (SLEEVE_IDS as readonly string[]).includes(m.sleeve) && typeof m.symbol === "string" && isNum(m.dropPct)) misses.push({ session: m.session, sleeve: m.sleeve as SleeveId, symbol: m.symbol, dropPct: m.dropPct });
  }
  return { ok: true, value: { applied: a as LedgerBlock, misses } };
}

// ── the week's slice of the ledger ───────────────────────────────────────────────────────────────
const within = (date: string, w: Week) => date >= w.start && date <= w.end;

export interface WeekSlice { block: LedgerBlock; episodes: Episode[]; fridayPending: boolean }

export function weekSlice(applied: LedgerBlock, w: Week): WeekSlice {
  const episodes: Episode[] = [];
  let fridayPending = false;
  for (const e of applied.episodes) {
    const days: DayEffect[] = e.days.filter(d => within(d.nextSession, w));
    if (e.days.some(d => d.session === w.end && d.nextSession > w.end && d.effectUsd === null)) fridayPending = true;
    if (days.length === 0) continue;
    const measured = days.map(d => d.effectUsd).filter((x): x is number => x !== null);
    const startCostUsd = within(e.days[0].nextSession, w) ? e.startCostUsd : 0;
    const endCostUsd = e.endSession !== null && within(e.endSession, w) ? e.endCostUsd : 0;
    const effectUsd = measured.reduce((a, b) => a + b, 0);
    const costUsd = startCostUsd + endCostUsd;
    // A bet's gain is not an avoided loss: its effect goes in effectUsd only (blockOf reports it as the bets' own line).
    const bet = e.kind === "bet";
    episodes.push({
      ...e, days, startCostUsd, endCostUsd, costUsd, effectUsd,
      savedUsd: bet ? 0 : measured.filter(x => x > 0).reduce((a, b) => a + b, 0), missedUsd: bet ? 0 : measured.filter(x => x < 0).reduce((a, b) => a - b, 0),
      pendingDays: days.length - measured.length, netUsd: effectUsd - costUsd,
    });
  }
  return { block: blockOf(episodes), episodes, fridayPending };
}

const ACTION_VERB: Record<OverrideAction, string> = { exit: "Sacó", short: "Sacó", reduce: "Redujo a la mitad" };

function episodeLine(e: Episode): string {
  const measured = e.days.length - e.pendingDays;
  const still = e.endSession === null ? " (sigue)" : "";
  // Stage C: "Apostó contra Nvidia (NVDA) 3 días: ganó $120." / "perdió $80."
  if (e.kind === "bet") return `Apostó contra ${companyLabel(e.symbol)} ${plural(e.days.length, "día", "días")}${still}: ${betResultWords(e.effectUsd, measured)}.`;
  return `${ACTION_VERB[e.action]} ${companyLabel(e.symbol)} ${plural(e.days.length, "día", "días")}${still}: ${resultWords(e.effectUsd, measured, true)}.`;
}

const pctEs = (x: number) => `−${x.toFixed(1).replace(".", ",")} %`;

/** The strong falls measured this week, oldest first. */
function weekMisses(misses: readonly HistoryMiss[], w: Week): HistoryMiss[] {
  return misses.filter(m => within(nextSessionOf(m.session), w)).sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : b.dropPct - a.dropPct));
}

function missesLine(ms: HistoryMiss[], w: Week): string {
  if (ms.length === 0) return "No vio ninguna caída fuerte.";
  const shown = ms.slice(0, 5).map(m => `${companyLabel(m.symbol)} ${pctEs(m.dropPct)} el ${within(m.session, w) ? weekdayOf(m.session) : sessionLabel(m.session)}`);
  const more = ms.length > 5 ? ` y ${ms.length - 5} más` : "";
  return `No vio ${ms.length === 1 ? "1 caída fuerte" : `${ms.length} caídas fuertes`}: ${shown.join("; ")}${more}.`;
}

// ── the adjustments log (docs/reports/IA-ajustes.md) ─────────────────────────────────────────────
export interface AdjustmentEntry {
  date: string;
  /** `change` only when the heading says "Cambio"; "Sin cambios" and "Propuesta" entries change nothing. */
  kind: "change" | "none";
  title: string;
  /** The entry's "Para el dueño" sentence: what the weekly message quotes. */
  forOwner: string | null;
}

/** Entries are `## YYYY-MM-DD · Cambio: …` / `## YYYY-MM-DD · Sin cambios: …` with a line `Para el dueño: one plain sentence`. */
export function parseAdjustments(md: string): AdjustmentEntry[] {
  const out: AdjustmentEntry[] = [];
  const parts = md.split(/^## (?=\d{4}-\d{2}-\d{2}\b)/m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split("\n");
    const m = head.match(/^(\d{4}-\d{2}-\d{2})\s*[·—-]\s*(.*)$/);
    if (!m) continue;
    let forOwner: string | null = null;
    for (const line of rest) {
      const t = line.replace(/\*\*/g, "").replace(/^\s*[-*]\s*/, "").trim();
      const s = t.match(/^Para el dueño:\s*(.+)$/i);
      if (s) { forOwner = s[1].trim(); break; }
    }
    out.push({ date: m[1], kind: /^cambio\b/i.test(m[2].trim()) ? "change" : "none", title: m[2].trim(), forOwner });
  }
  return out;
}

export type AgentOutcome = { kind: "ok" } | { kind: "skipped" | "failed"; reason: string } | { kind: "violated" };

const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** "Ajustes de esta semana: …": the plain sentences of this week's entries, or why there are none. */
export function adjustmentsLine(entries: readonly AdjustmentEntry[], agent: AgentOutcome): string {
  const head = "Ajustes de esta semana:";
  if (agent.kind === "skipped" || agent.kind === "failed") return `${head} no se pudo revisar (${agent.reason.trim().replace(/[.\s]+$/, "")}).`;
  if (agent.kind === "violated") return `${head} los revisará una persona antes de darlos por buenos (el ajuste tocó algo que no debía).`;
  if (entries.length === 0) return `${head} no quedó anotada la revisión de esta semana.`;
  const changes = entries.filter(e => e.kind === "change");
  if (changes.length === 0) {
    const why = [...entries].reverse().find(e => e.forOwner)?.forOwner;
    return `${head} ninguno.${why ? ` ${sentence(why)}` : ""}`;
  }
  const lines = changes.map(e => sentence(e.forOwner ?? `hubo un cambio (${e.title.replace(/^cambio:?\s*/i, "")})`));
  return lines.length === 1 ? `${head} ${lines[0]}` : [head, ...lines.map(l => `• ${l}`)].join("\n");
}

// ── the message ──────────────────────────────────────────────────────────────────────────────────
export interface WeeklyInput {
  /** null: the ledger could not be read. */
  data: WeeklyData | null;
  week: Week;
  /** Entries of the log dated from the week's Monday to today. */
  adjustments: readonly AdjustmentEntry[];
  agent: AgentOutcome;
  start?: string;
}

export function weeklyMessage(i: WeeklyInput): string {
  const head = `🧠 Revisión de IA · ${weekLabel(i.week)}`;
  const start = i.start ?? AI_REVIEW_START;
  const last = adjustmentsLine(i.adjustments, i.agent);
  if (!i.data) return [head, "No se pudieron leer los resultados de la revisión esta semana.", last].join("\n");

  const slice = weekSlice(i.data.applied, i.week);
  const lines = [head];
  if (slice.block.decisions === 0) lines.push("Esta semana la revisión no tomó ninguna decisión.");
  else {
    lines.push(summaryAfter(`Tomó ${plural(slice.block.decisions, "decisión", "decisiones")}`, slice.block, true));
    for (const e of slice.episodes) lines.push(episodeLine(e));
  }
  if (slice.fridayPending) lines.push("Lo del viernes se mide el lunes.");
  lines.push(missesLine(weekMisses(i.data.misses, i.week), i.week));
  const all = i.data.applied;
  lines.push(all.decisions === 0 ? `Desde el inicio (${dayShort(start)}): todavía ninguna decisión.`
    : all.cases === all.pendingCases ? `Desde el inicio (${dayShort(start)}): todavía sin precios para medir.`
    : `Desde el inicio (${dayShort(start)}): neto ${signedUsd(netWhole(all))}.`);
  lines.push(last);
  return lines.join("\n");
}

// ── what the weekly agent is shown: how each model did in the week's runs (counted by code, not by the agent) ─────────────
/** A model that failed in this many of the week's runs may be replaced (the rule written in the agent's prompt). */
export const PANEL_FAILURE_RUNS = 3;

export interface RunRecord { session: string; record: unknown }
export interface ModelWeek {
  model: string;
  family: string;
  /** Runs in which the model was asked (or skipped). */
  runs: number;
  /** Asked and failed (error, timeout, invalid answer). A closed quota, a family already in the run or a deadline is not a failure of the model. */
  failures: number;
  /** Not asked: quota closed, family already in the run, deadline. */
  skipped: number;
  errors: string[];
  /** Runs where it opened web searches. */
  searched: number;
  /** Non-keep verdicts it gave, by action. */
  verdicts: Record<OverrideAction, number>;
  failedInThreeOrMore: boolean;
}
export interface RunsDigest { sessions: string[]; runsWithoutDecision: number; models: ModelWeek[] }

const NOT_A_FAILURE = /quota closed|family already in this run|deadline reached/i;

export function digestRuns(records: readonly RunRecord[]): RunsDigest {
  const byModel = new Map<string, ModelWeek>();
  let withoutDecision = 0;
  for (const { record } of records) {
    const r = record as { models?: unknown; verdicts?: unknown; notes?: unknown } | null;
    const models = Array.isArray(r?.models) ? (r!.models as any[]) : [];
    const verdicts = Array.isArray(r?.verdicts) ? (r!.verdicts as any[]) : [];
    if (verdicts.length < 2) withoutDecision++;
    for (const m of models) {
      if (!m || typeof m.model !== "string") continue;
      const w: ModelWeek = byModel.get(m.model) ?? { model: m.model, family: String(m.family ?? ""), runs: 0, failures: 0, skipped: 0, errors: [], searched: 0, verdicts: { exit: 0, reduce: 0, short: 0 }, failedInThreeOrMore: false };
      w.runs++;
      if (m.ok === false) {
        const err = String(m.error ?? "unknown");
        if (NOT_A_FAILURE.test(err)) w.skipped++; else w.failures++;
        if (!w.errors.includes(err.slice(0, 120)) && w.errors.length < 5) w.errors.push(err.slice(0, 120));
      }
      if (m.searched === true) w.searched++;
      if (m.ok === true) {
        const fv = verdicts.find(v => v && v.family === m.family);
        const given = fv?.verdict?.verdicts && typeof fv.verdict.verdicts === "object" ? Object.values(fv.verdict.verdicts as Record<string, { action?: string }>) : [];
        for (const v of given) if (v && (v.action === "exit" || v.action === "reduce" || v.action === "short")) w.verdicts[v.action]++;
      }
      byModel.set(m.model, w);
    }
  }
  const models = [...byModel.values()].map(w => ({ ...w, failedInThreeOrMore: w.failures >= PANEL_FAILURE_RUNS })).sort((a, b) => (a.model < b.model ? -1 : 1));
  return { sessions: records.map(r => r.session).sort(), runsWithoutDecision: withoutDecision, models };
}

// ── the one file the weekly agent may edit inside src/: the panel ───────────────────────────────────────────────────────
const PANEL_BLOCKS = [
  /export const PRIMARIES\b[^=]*=\s*\[[\s\S]*?\];/,
  /export const SUBSTITUTES\b[^=]*=\s*\[[\s\S]*?\];/,
  /const INFO\b[^=]*=\s*\{[\s\S]*?\n\};/,
];

/** True when `after` differs from `before` only inside PRIMARIES, SUBSTITUTES and the INFO table (a new model's family): thresholds,
 *  PANEL_SIZE, the gate and every other line must be byte-identical. */
export function onlyPanelChanged(before: string, after: string): boolean {
  const mask = (s: string) => PANEL_BLOCKS.reduce((t, re, i) => t.replace(re, `/*PANEL${i}*/`), s);
  if (PANEL_BLOCKS.some(re => !re.test(before) || !re.test(after))) return false;
  return mask(before) === mask(after);
}
