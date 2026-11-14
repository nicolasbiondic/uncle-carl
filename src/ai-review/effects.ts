// The effect ledger of the AI review (docs/reports/IA-revision-de-noticias-2026-11-14.md §4). Pure: it reads journaled
// passes and daily opens handed to it, never a database. scripts/ai-review-report.ts feeds it from trading.db and
// historical.db, both read-only.
//
//   effect of a day-action = (appliedWeight − modelWeight) × the pass's sleeve equity × (open(next session) ÷ open(session) − 1)
//   cost                   = 10 bp per side on |Δweight| × equity, charged ONCE when an override starts and ONCE when it ends
//   pending                = the next session's open is not in historical.db yet (the day counts as a case, not as money)
//
// Applied days (diagnostics.aiReview.applied === true) and hypothetical ones (the switch was off: only informed) are two
// SEPARATE ledgers and are never added together; only the applied one counts for the verdict.
// Enforced: src/ai-review/effects.test.ts.

import { SLEEVE_IDS, SLEEVE_NAMES, type OverrideAction, type SleeveId } from "./contract";
import { readJournaledReview } from "./apply";
import { companyLabel, sessionLabel } from "./texts";
import { isTradingDay } from "../utils/marketHours";

/** Pre-registered (§4): 10 basis points per side on what the action made the bot trade. */
export const COST_BP_PER_SIDE = 10;
/** Pre-registered reading threshold: cases (day-actions) needed before the verdict is read. */
export const MIN_CASES = 20;

export interface JournalPass { sleeve: string; session: string; status: string; equity: number; diagnostics: unknown }
/** The session's daily open for a symbol, null when it is not in the data yet. */
export type OpenLookup = (symbol: string, session: string) => number | null;

export interface DayEffect {
  session: string;
  nextSession: string;
  action: OverrideAction;
  modelWeight: number;
  appliedWeight: number;
  equity: number;
  open: number | null;
  nextOpen: number | null;
  /** Null while pending. */
  returnPct: number | null;
  effectUsd: number | null;
}

export interface Episode {
  sleeve: SleeveId;
  symbol: string;
  applied: boolean;
  action: OverrideAction;
  days: DayEffect[];
  startSession: string;
  lastSession: string;
  /** The session the model's weight came back (the first pass without the override), null while it goes on. */
  endSession: string | null;
  /** Why it ended: the model (override lifted / expired) or the switch changed mode (applied → informing, or the reverse). */
  endedBy: "model" | "switch" | null;
  /** Sum of the days that could be measured. */
  effectUsd: number;
  /** Sum of the positive day effects (losses avoided) and of the negative ones (gains missed, as a positive number). */
  savedUsd: number;
  missedUsd: number;
  startCostUsd: number;
  endCostUsd: number;
  costUsd: number;
  pendingDays: number;
  netUsd: number;
}

export interface LedgerBlock {
  episodes: Episode[];
  decisions: number;
  /** Distinct sessions with at least one case. */
  sessions: number;
  /** Day-actions (session, sleeve, symbol): the unit the pre-registration counts. */
  cases: number;
  pendingCases: number;
  savedUsd: number;
  missedUsd: number;
  costUsd: number;
  netUsd: number;
}
export interface Ledger { applied: LedgerBlock; hypothetical: LedgerBlock }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The next NYSE session after `session` (the repo's calendar). */
export function nextSessionOf(session: string): string {
  for (let t = Date.parse(`${session}T00:00:00Z`) + 86_400_000, guard = 0; guard < 15; t += 86_400_000, guard++) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingDay(d)) return d;
  }
  throw new Error(`no NYSE session within 15 days after ${session}`);
}

interface PassView { sleeve: SleeveId; session: string; equity: number; review: ReturnType<typeof readJournaledReview> }

function effectIn(p: PassView, symbol: string, applied: boolean) {
  return p.review && p.review.applied === applied ? p.review.effects.find(e => e.symbol === symbol) : undefined;
}

export function buildLedger(passes: readonly JournalPass[], opens: OpenLookup, nextSession: (s: string) => string = nextSessionOf): Ledger {
  const bySleeve = new Map<SleeveId, PassView[]>();
  for (const p of passes) {
    if (p.sleeve !== "momentum_stocks" && p.sleeve !== "meanrev_stocks") continue;
    if (p.status !== "submitted" && p.status !== "decided") continue;
    const list = bySleeve.get(p.sleeve) ?? [];
    const view: PassView = { sleeve: p.sleeve, session: p.session, equity: p.equity, review: readJournaledReview(p.diagnostics) };
    const at = list.findIndex(x => x.session === p.session);
    if (at >= 0) list[at] = view; else list.push(view);
    bySleeve.set(p.sleeve, list);
  }
  const out: Record<"applied" | "hypothetical", Episode[]> = { applied: [], hypothetical: [] };
  for (const [sleeve, list] of bySleeve) {
    list.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    for (const applied of [true, false]) {
      const symbols = [...new Set(list.flatMap(p => (p.review && p.review.applied === applied ? p.review.effects.map(e => e.symbol) : [])))].sort();
      for (const symbol of symbols) {
        let run: PassView[] = [];
        const finish = (end: PassView | null) => {
          if (run.length === 0) return;
          const otherMode = end ? effectIn(end, symbol, !applied) !== undefined : false;
          out[applied ? "applied" : "hypothetical"].push(episodeOf(sleeve, symbol, applied, run, end, end ? (otherMode ? "switch" : "model") : null, opens, nextSession));
          run = [];
        };
        for (const p of list) {
          if (effectIn(p, symbol, applied)) run.push(p);
          else finish(p);
        }
        finish(null);
      }
    }
  }
  return { applied: blockOf(out.applied), hypothetical: blockOf(out.hypothetical) };
}

function episodeOf(sleeve: SleeveId, symbol: string, applied: boolean, run: PassView[], end: PassView | null, endedBy: "model" | "switch" | null,
  opens: OpenLookup, nextSession: (s: string) => string): Episode {
  const days: DayEffect[] = run.map(p => {
    const e = effectIn(p, symbol, applied)!;
    const next = nextSession(p.session);
    const open = opens(symbol, p.session), nextOpen = opens(symbol, next);
    const known = open !== null && nextOpen !== null && open > 0 && nextOpen > 0;
    const returnPct = known ? nextOpen! / open! - 1 : null;
    return { session: p.session, nextSession: next, action: e.action, modelWeight: e.modelWeight, appliedWeight: e.appliedWeight, equity: p.equity,
      open, nextOpen, returnPct, effectUsd: returnPct === null ? null : (e.appliedWeight - e.modelWeight) * p.equity * returnPct };
  });
  const measured = days.map(d => d.effectUsd).filter((x): x is number => x !== null);
  const first = days[0], last = days[days.length - 1];
  const rate = COST_BP_PER_SIDE / 10_000;
  const startCostUsd = rate * Math.abs(first.appliedWeight - first.modelWeight) * first.equity;
  // The end pays when the model's weight really came back: always for an applied override; for an informed-only one only when it
  // ended because the model lifted it (a switch to applying is an applied start, charged in the applied ledger).
  const endCostUsd = end && (applied || endedBy === "model") ? rate * Math.abs(last.appliedWeight - last.modelWeight) * end.equity : 0;
  const effectUsd = sum(measured);
  const costUsd = startCostUsd + endCostUsd;
  return {
    sleeve, symbol, applied, action: first.action, days, startSession: first.session, lastSession: last.session,
    endSession: end?.session ?? null, endedBy, effectUsd,
    savedUsd: sum(measured.filter(x => x > 0)), missedUsd: sum(measured.filter(x => x < 0).map(x => -x)),
    startCostUsd, endCostUsd, costUsd, pendingDays: days.length - measured.length, netUsd: effectUsd - costUsd,
  };
}

function blockOf(episodes: Episode[]): LedgerBlock {
  const order = (a: Episode, b: Episode) => (a.startSession < b.startSession ? -1 : a.startSession > b.startSession ? 1
    : SLEEVE_IDS.indexOf(a.sleeve) - SLEEVE_IDS.indexOf(b.sleeve) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  episodes.sort(order);
  return {
    episodes, decisions: episodes.length,
    sessions: new Set(episodes.flatMap(e => e.days.map(d => d.session))).size,
    cases: sum(episodes.map(e => e.days.length)), pendingCases: sum(episodes.map(e => e.pendingDays)),
    savedUsd: sum(episodes.map(e => e.savedUsd)), missedUsd: sum(episodes.map(e => e.missedUsd)),
    costUsd: sum(episodes.map(e => e.costUsd)), netUsd: sum(episodes.map(e => e.netUsd)),
  };
}

// ── the words (texto-para-personas: Spanish, whole dollars, a plain name on every ticker) ──
const minus = "−";
/** $310; a positive amount under a dollar reads <$1. */
export function usd(n: number): string {
  const r = Math.round(Math.abs(n));
  return r === 0 && Math.abs(n) > 0 ? "<$1" : `$${r.toLocaleString("en-US")}`;
}
/** The same amount inside a sentence: "menos de $1" rather than the table's "<$1". */
const usdWords = (n: number): string => (usd(n) === "<$1" ? "menos de $1" : usd(n));
export function signedUsd(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${usd(n)}` : r < 0 ? `${minus}${usd(n)}` : "$0";
}
const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

const ACTION_WORDS: Record<"applied" | "hypothetical", Record<OverrideAction, string>> = {
  applied: { exit: "sacada", short: "sacada", reduce: "reducida a la mitad" },
  hypothetical: { exit: "se habría sacado", short: "se habría sacado", reduce: "se habría reducido a la mitad" },
};

function episodeLine(e: Episode): string {
  const word = ACTION_WORDS[e.applied ? "applied" : "hypothetical"][e.action];
  const n = e.days.length;
  const when = e.endSession === null
    ? `desde el ${sessionLabel(e.startSession)} (sigue, ${plural(n, "día", "días")})`
    : n === 1 ? `el ${sessionLabel(e.startSession)}` : `del ${sessionLabel(e.startSession)} al ${sessionLabel(e.lastSession)} (${n} días)`;
  const measured = e.days.length - e.pendingDays;
  const result = measured === 0 ? "resultado pendiente"
    : Math.round(e.effectUsd) > 0 ? `evitó ${usd(e.effectUsd)} de pérdidas`
    : Math.round(e.effectUsd) < 0 ? `dejó de ganar ${usd(e.effectUsd)}` : "sin efecto en dólares";
  const parts = [`• ${companyLabel(e.symbol)}, ${SLEEVE_NAMES[e.sleeve]}: ${word} ${when}`, e.pendingDays > 0 && measured > 0 ? `${result} (${plural(e.pendingDays, "día pendiente", "días pendientes")})` : result];
  if (e.costUsd > 0) parts.push(`operar costó ${usdWords(e.costUsd)}`);
  return parts.join(" · ");
}

function summary(b: LedgerBlock, applied: boolean): string {
  if (b.decisions === 0) return applied ? "La revisión de IA todavía no ha cambiado ninguna orden." : "Nada: la revisión no propuso cambios sobre acciones que el modelo tuviera.";
  const lead = applied
    ? `La revisión de IA lleva ${plural(b.decisions, "decisión aplicada", "decisiones aplicadas")} en ${plural(b.sessions, "día", "días")}`
    : `Habría aplicado ${plural(b.decisions, "decisión", "decisiones")} en ${plural(b.sessions, "día", "días")}`;
  if (b.cases === b.pendingCases) return `${lead}; todavía no hay precios para medir el efecto.`;
  const avoided = applied ? "evitó" : "habría evitado", lost = applied ? "dejó de ganar" : "habría dejado de ganar";
  const cost = b.costUsd > 0 ? `; operar ${applied ? "costó" : "habría costado"} ${usdWords(b.costUsd)}` : "";
  // The net is the sum of what is printed (whole dollars), so the line always adds up on screen; the JSON carries the exact figure.
  const net = Math.round(b.savedUsd) - Math.round(b.missedUsd) - Math.round(b.costUsd);
  return `${lead}: ${avoided} ${usd(b.savedUsd)} de pérdidas y ${lost} ${usd(b.missedUsd)}${cost}. Neto: ${signedUsd(net)}.`;
}

export function renderLedger(l: Ledger): string {
  const lines: string[] = [];
  lines.push(summary(l.applied, true));
  for (const e of l.applied.episodes) lines.push(episodeLine(e));
  if (l.applied.pendingCases > 0) lines.push(`Faltan ${plural(l.applied.pendingCases, "caso", "casos")} por medir: esperan la apertura del día siguiente.`);
  lines.push(`Para el veredicto hacen falta ${MIN_CASES} casos (una acción cambiada en un día): ${l.applied.cases === 1 ? "va 1" : `van ${l.applied.cases}`}.`);
  if (l.hypothetical.decisions > 0 || l.hypothetical.cases > 0) {
    lines.push("", "Lo que habría hecho mientras solo informaba (no cuenta para el veredicto)", summary(l.hypothetical, false));
    for (const e of l.hypothetical.episodes) lines.push(episodeLine(e));
  }
  return lines.join("\n");
}
