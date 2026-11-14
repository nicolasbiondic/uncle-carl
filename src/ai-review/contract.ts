// AI review (stage A, docs/reports/IA-revision-de-noticias-2026-11-14.md §3):
// the three data shapes and their STRICT validators. Pure: nothing in this
// module (or in src/ai-review/) imports an engine, AccountManager or a broker.
//
//   CaseFile      the day's facts for the two stock sleeves (built on prod, read-only)
//   ModelVerdict  what ONE model answers about the case file
//   Decision      what is shipped to the bot: the quorum of the verdicts, inside the limits
//
// Every validator returns {ok, value|error}; none throws. A file or a model
// answer is never trusted: it is re-validated at every hop (enforced:
// src/ai-review/contract.test.ts, src/ai-review/active.test.ts).

import { createHash } from "node:crypto";

export const SLEEVE_IDS = ["momentum_stocks", "meanrev_stocks"] as const;
export type SleeveId = (typeof SLEEVE_IDS)[number];

/** Owner-facing names (texto-para-personas: one name per strategy). */
export const SLEEVE_NAMES: Readonly<Record<SleeveId, string>> = {
  momentum_stocks: "Momentum Acciones",
  meanrev_stocks: "Reversión Acciones",
};

export const ACTIONS = ["keep", "reduce", "exit", "short"] as const;
export type Action = (typeof ACTIONS)[number];
export type OverrideAction = Exclude<Action, "keep">;
export const OVERRIDE_ACTIONS: readonly OverrideAction[] = ["reduce", "exit", "short"];

export const REASON_MAX_CHARS = 240;
export const SUMMARY_MAX_CHARS = 300;

export interface CaseNews { at: string; source: string; headline: string; summary: string; url: string }
export interface CasePreMarket { price: number; changePct: number; at: string }
export interface CaseSymbol {
  symbol: string;
  name: string;
  held: boolean;
  positionUsd: number | null;
  sinceEntryUsd: number | null;
  daysHeld: number | null;
  lastClose: number;
  ret1dPct: number | null;
  ret5dPct: number | null;
  preMarket: CasePreMarket | null;
  news: CaseNews[];
}
export interface CaseSleeve { id: SleeveId; name: string; valueUsd: number | null; symbols: CaseSymbol[] }
export interface CaseFile {
  session: string;
  builtAt: string;
  sleeves: CaseSleeve[];
  /** Things the builder could not read (pre-market, part of the news); the runner reports them to OPS. */
  warnings?: string[];
}

export interface Verdict { action: Action; confidence: number; reason: string; sources: string[] }
export interface ModelVerdict { session: string; verdicts: Record<string, Verdict> }

export interface ModelRecord { model: string; family: string; ok: boolean; error: string | null; searched: boolean }
export interface Vote { family: string; action: OverrideAction; confidence: number }
export interface Override {
  sleeve: SleeveId;
  symbol: string;
  action: OverrideAction;
  factor: number;
  meanConfidence: number;
  votes: Vote[];
  reason: string;
  sources: string[];
}
export interface Dropped { sleeve: SleeveId | null; symbol: string; why: string }
export interface Decision {
  id: string;
  session: string;
  decidedAt: string;
  stage: "inform";
  models: ModelRecord[];
  overrides: Override[];
  dropped: Dropped[];
  reviewed: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

// ── small checks ─────────────────────────────────────────────────────────
export const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);
const isStr = (x: unknown): x is string => typeof x === "string";

export function isDateKey(x: unknown): x is string {
  if (!isStr(x) || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const t = Date.parse(`${x}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === x;
}
export const isInstant = (x: unknown): x is string => isStr(x) && x.length <= 40 && Number.isFinite(Date.parse(x));
export function isHttpUrl(x: unknown): x is string {
  if (!isStr(x) || x.length > 2000) return false;
  try { const u = new URL(x); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

// ── CaseFile ─────────────────────────────────────────────────────────────
export function parseCaseFile(input: unknown): Parsed<CaseFile> {
  if (!isRecord(input)) return bad("case file is not an object");
  if (!isDateKey(input.session)) return bad("case file: session must be YYYY-MM-DD");
  if (!isInstant(input.builtAt)) return bad("case file: builtAt must be an ISO instant");
  if (!Array.isArray(input.sleeves) || input.sleeves.length < 1 || input.sleeves.length > SLEEVE_IDS.length) return bad("case file: sleeves must be a list of 1-2");
  const sleeves: CaseSleeve[] = [];
  const seenSleeves = new Set<string>();
  for (const [i, s] of input.sleeves.entries()) {
    const at = `sleeves[${i}]`;
    if (!isRecord(s)) return bad(`${at} is not an object`);
    if (!(SLEEVE_IDS as readonly string[]).includes(s.id as string)) return bad(`${at}.id is not a stock sleeve`);
    if (seenSleeves.has(s.id as string)) return bad(`${at}.id repeated`);
    seenSleeves.add(s.id as string);
    if (!isStr(s.name) || !s.name) return bad(`${at}.name missing`);
    if (!isNumOrNull(s.valueUsd)) return bad(`${at}.valueUsd must be a number or null`);
    if (!Array.isArray(s.symbols) || s.symbols.length > 100) return bad(`${at}.symbols must be a list (max 100)`);
    const symbols: CaseSymbol[] = [];
    const seen = new Set<string>();
    for (const [j, y] of s.symbols.entries()) {
      const p = `${at}.symbols[${j}]`;
      if (!isRecord(y)) return bad(`${p} is not an object`);
      if (!isStr(y.symbol) || !SYMBOL_RE.test(y.symbol)) return bad(`${p}.symbol is not a ticker`);
      if (seen.has(y.symbol)) return bad(`${p}.symbol repeated`);
      seen.add(y.symbol);
      if (!isStr(y.name) || !y.name) return bad(`${p}.name missing`);
      if (typeof y.held !== "boolean") return bad(`${p}.held must be a boolean`);
      for (const k of ["positionUsd", "sinceEntryUsd", "daysHeld", "ret1dPct", "ret5dPct"] as const) {
        if (!isNumOrNull(y[k])) return bad(`${p}.${k} must be a number or null`);
      }
      if (!isNum(y.lastClose) || y.lastClose <= 0) return bad(`${p}.lastClose must be a positive number`);
      let preMarket: CasePreMarket | null = null;
      if (y.preMarket !== null) {
        const pm = y.preMarket;
        if (!isRecord(pm) || !isNum(pm.price) || pm.price <= 0 || !isNum(pm.changePct) || !isInstant(pm.at)) return bad(`${p}.preMarket is malformed`);
        preMarket = { price: pm.price, changePct: pm.changePct, at: pm.at };
      }
      if (!Array.isArray(y.news) || y.news.length > 50) return bad(`${p}.news must be a list (max 50)`);
      const news: CaseNews[] = [];
      for (const [k, n] of y.news.entries()) {
        const q = `${p}.news[${k}]`;
        if (!isRecord(n)) return bad(`${q} is not an object`);
        if (!isInstant(n.at)) return bad(`${q}.at must be an ISO instant`);
        if (!isStr(n.source) || !isStr(n.headline) || !n.headline || !isStr(n.summary)) return bad(`${q} needs source, headline and summary strings`);
        if (!isHttpUrl(n.url)) return bad(`${q}.url must be http(s)`);
        news.push({ at: n.at, source: n.source, headline: n.headline, summary: n.summary, url: n.url });
      }
      symbols.push({
        symbol: y.symbol, name: y.name, held: y.held,
        positionUsd: y.positionUsd as number | null, sinceEntryUsd: y.sinceEntryUsd as number | null, daysHeld: y.daysHeld as number | null,
        lastClose: y.lastClose, ret1dPct: y.ret1dPct as number | null, ret5dPct: y.ret5dPct as number | null, preMarket, news,
      });
    }
    sleeves.push({ id: s.id as SleeveId, name: s.name, valueUsd: s.valueUsd as number | null, symbols });
  }
  const out: CaseFile = { session: input.session, builtAt: input.builtAt, sleeves };
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings) || input.warnings.length > 50 || !input.warnings.every(isStr)) return bad("case file: warnings must be a list of strings");
    out.warnings = input.warnings as string[];
  }
  return good(out);
}

/** Symbol → the sleeves whose universe (the case file's symbols) has it. */
export function universeOf(cf: CaseFile): Record<SleeveId, string[]> {
  const u = { momentum_stocks: [] as string[], meanrev_stocks: [] as string[] };
  for (const s of cf.sleeves) u[s.id] = s.symbols.map(y => y.symbol);
  return u;
}
export const countSymbols = (cf: CaseFile): number => cf.sleeves.reduce((n, s) => n + s.symbols.length, 0);

// ── ModelVerdict ─────────────────────────────────────────────────────────
/** Strip a ```json fence, then fall back to the outermost braces (a model that adds a sentence around the JSON). */
export function extractJsonText(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  if (body.startsWith("{") && body.endsWith("}")) return body;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  return a !== -1 && b > a ? body.slice(a, b + 1) : body;
}

/** Top-level keys besides `session` and `verdicts` are tolerated only when they are strings (a stray "notes"); anything else rejects. */
export function parseModelVerdict(raw: string, cf: CaseFile): Parsed<ModelVerdict> {
  let obj: unknown;
  try { obj = JSON.parse(extractJsonText(raw)); } catch (e) { return bad(`the answer is not valid JSON (${(e as Error).message.slice(0, 80)})`); }
  if (!isRecord(obj)) return bad("the answer is not a JSON object");
  if (obj.session !== cf.session) return bad(`session must be exactly "${cf.session}"`);
  if (!isRecord(obj.verdicts)) return bad("verdicts must be an object keyed by symbol");
  for (const k of Object.keys(obj)) {
    if (k === "session" || k === "verdicts") continue;
    if (!isStr(obj[k])) return bad(`unexpected top-level key "${k}" (only "session" and "verdicts")`);
  }
  const known = new Set(cf.sleeves.flatMap(s => s.symbols.map(y => y.symbol)));
  const verdicts: Record<string, Verdict> = {};
  for (const symbol of Object.keys(obj.verdicts)) {
    if (!known.has(symbol)) return bad(`${symbol} is not in the case file`);
    const v = (obj.verdicts as Record<string, unknown>)[symbol];
    if (!isRecord(v)) return bad(`${symbol}: the verdict must be an object`);
    if (!isStr(v.action) || !(ACTIONS as readonly string[]).includes(v.action)) return bad(`${symbol}: unknown action ${JSON.stringify(v.action)} (keep, reduce, exit or short)`);
    const action = v.action as Action;
    if (!isNum(v.confidence) || v.confidence < 0 || v.confidence > 1) return bad(`${symbol}: confidence must be a number from 0 to 1`);
    let reason = "";
    if (v.reason !== undefined) {
      if (!isStr(v.reason)) return bad(`${symbol}: reason must be a string`);
      if (v.reason.length > REASON_MAX_CHARS) return bad(`${symbol}: reason has ${v.reason.length} characters (max ${REASON_MAX_CHARS})`);
      reason = v.reason.trim();
    }
    let sources: string[] = [];
    if (v.sources !== undefined) {
      if (!Array.isArray(v.sources) || v.sources.length > 20 || !v.sources.every(isHttpUrl)) return bad(`${symbol}: sources must be a list of http(s) links`);
      sources = [...new Set(v.sources as string[])];
    }
    if (action !== "keep") {
      if (!reason) return bad(`${symbol}: a ${action} needs a reason`);
      if (sources.length === 0) return bad(`${symbol}: a ${action} needs at least one source link`);
    }
    verdicts[symbol] = { action, confidence: v.confidence, reason, sources };
  }
  return good({ session: cf.session, verdicts });
}

// ── Decision ─────────────────────────────────────────────────────────────
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (isRecord(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x) ?? "null";
}

/** sha256 of the canonical content (every key but `id`), first 12 hex chars. */
export function decisionId(d: Omit<Decision, "id">): string {
  return createHash("sha256").update(canonical(d)).digest("hex").slice(0, 12);
}

export function sealDecision(d: Omit<Decision, "id">): Decision {
  return { id: decisionId(d), ...d };
}

/** Structural validation only (the limits are re-applied by active.ts). The id must match the content. */
export function parseDecision(input: unknown): Parsed<Decision> {
  if (!isRecord(input)) return bad("decision is not an object");
  if (!isStr(input.id) || !/^[0-9a-f]{12}$/.test(input.id)) return bad("decision: id must be 12 hex chars");
  if (!isDateKey(input.session)) return bad("decision: session must be YYYY-MM-DD");
  if (!isInstant(input.decidedAt)) return bad("decision: decidedAt must be an ISO instant");
  if (input.stage !== "inform") return bad("decision: unknown stage");
  if (!Array.isArray(input.models) || input.models.length > 12) return bad("decision: models must be a list (max 12)");
  const models: ModelRecord[] = [];
  for (const m of input.models) {
    if (!isRecord(m) || !isStr(m.model) || !isStr(m.family) || typeof m.ok !== "boolean" || typeof m.searched !== "boolean" || !(m.error === null || isStr(m.error))) return bad("decision: a models entry is malformed");
    models.push({ model: m.model, family: m.family, ok: m.ok, error: m.error as string | null, searched: m.searched });
  }
  if (!Array.isArray(input.overrides) || input.overrides.length > 50) return bad("decision: overrides must be a list (max 50)");
  const overrides: Override[] = [];
  for (const o of input.overrides) {
    if (!isRecord(o)) return bad("decision: an override is not an object");
    if (!(SLEEVE_IDS as readonly string[]).includes(o.sleeve as string)) return bad("decision: override sleeve unknown");
    if (!isStr(o.symbol) || !SYMBOL_RE.test(o.symbol)) return bad("decision: override symbol malformed");
    if (!(OVERRIDE_ACTIONS as readonly string[]).includes(o.action as string)) return bad("decision: override action must be reduce, exit or short");
    if (!isNum(o.factor) || o.factor < 0 || o.factor > 1) return bad("decision: override factor out of [0,1]");
    if (!isNum(o.meanConfidence) || o.meanConfidence < 0 || o.meanConfidence > 1) return bad("decision: override meanConfidence out of [0,1]");
    if (!Array.isArray(o.votes) || o.votes.length < 1 || o.votes.length > 6) return bad("decision: override votes must be a list of 1-6");
    const votes: Vote[] = [];
    for (const v of o.votes) {
      if (!isRecord(v) || !isStr(v.family) || !(OVERRIDE_ACTIONS as readonly string[]).includes(v.action as string) || !isNum(v.confidence) || v.confidence < 0 || v.confidence > 1) return bad("decision: a vote is malformed");
      votes.push({ family: v.family, action: v.action as OverrideAction, confidence: v.confidence });
    }
    if (!isStr(o.reason) || o.reason.length > 2000) return bad("decision: override reason malformed");
    if (!Array.isArray(o.sources) || o.sources.length > 20 || !o.sources.every(isHttpUrl)) return bad("decision: override sources must be http(s) links");
    overrides.push({ sleeve: o.sleeve as SleeveId, symbol: o.symbol, action: o.action as OverrideAction, factor: o.factor, meanConfidence: o.meanConfidence, votes, reason: o.reason, sources: o.sources as string[] });
  }
  if (!Array.isArray(input.dropped) || input.dropped.length > 200) return bad("decision: dropped must be a list (max 200)");
  const dropped: Dropped[] = [];
  for (const d of input.dropped) {
    if (!isRecord(d) || !isStr(d.symbol) || !isStr(d.why) || !(d.sleeve === null || (SLEEVE_IDS as readonly string[]).includes(d.sleeve as string))) return bad("decision: a dropped entry is malformed");
    dropped.push({ sleeve: d.sleeve as SleeveId | null, symbol: d.symbol, why: d.why });
  }
  if (!Number.isInteger(input.reviewed) || (input.reviewed as number) < 0 || (input.reviewed as number) > 1000) return bad("decision: reviewed must be a count");
  const body: Omit<Decision, "id"> = { session: input.session, decidedAt: input.decidedAt, stage: "inform", models, overrides, dropped, reviewed: input.reviewed as number };
  if (decisionId(body) !== input.id) return bad("decision: id does not match its content");
  return good({ id: input.id, ...body });
}
