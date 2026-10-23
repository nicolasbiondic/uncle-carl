import type { CopySignalConfig, DecideInput, SessionDate, TargetBook } from "./types";
import { cappedInverseVolWeights } from "./construction";
import { compareSymbols, priceHistory, trailingVol } from "./signals";

const DAY_MS = 86_400_000;
const KEY = "copySignal";
/** A name with no bar this recent (calendar days before asOf) is not tradable: delisted/halted/not listed yet. */
export const MAX_BAR_STALENESS_DAYS = 7;

/** Versioned, JSON-only state of the copySignal kernel (TargetBook.memory.copySignal). */
export interface CopySignalMemory {
  version: 1;
  /** symbol → the asOf session on which it was (last) selected. */
  picks: Record<string, SessionDate>;
  /** symbol → cutoffMs of its last selection: events known at/before it are spent for that symbol. */
  spent: Record<string, number>;
}

function readMemory(memory: Readonly<Record<string, unknown>>): CopySignalMemory {
  const v = memory[KEY] as CopySignalMemory | undefined;
  return v?.version === 1 ? { version: 1, picks: { ...v.picks }, spent: { ...v.spent } } : { version: 1, picks: {}, spent: {} };
}

const daysBetween = (from: SessionDate, to: SessionDate) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Actor ids behind an event: `meta.actors` strings; an event without them counts as ONE shared unknown actor. */
function actorsOf(meta: Readonly<Record<string, unknown>>): string[] {
  const a = meta.actors;
  return Array.isArray(a) && a.length > 0 ? a.filter((x): x is string => typeof x === "string") : ["?"];
}

function hasRole(meta: Readonly<Record<string, unknown>>, roles: readonly string[]): boolean {
  const r = meta.role;
  return Array.isArray(r) && r.some(x => typeof x === "string" && roles.includes(x));
}

export interface CopyCandidate { symbol: string; insiders: number; dollars: number; events: number; lastKnownMs: number }

export function decideCopySignal(input: DecideInput & { config: CopySignalConfig }): TargetBook {
  const { view, config, book } = input;
  const signals = input.signals;
  if (!signals) throw new Error("copySignal requires DecideInput.signals (a point-in-time SignalView)");
  if (signals.asOf !== view.asOf) throw new Error(`copySignal: signals.asOf ${signals.asOf} must equal view.asOf ${view.asOf}`);
  if ((config.holdDays === undefined) === (config.holdSessions === undefined)) throw new Error("copySignal needs exactly one of holdDays / holdSessions");
  const prev = readMemory(book.memory);
  const cutoff = signals.cutoffMs;
  const asOf = view.asOf;

  // 1. Holds that ran their course leave. A name with no recent bar (or, for inverseVol, no vol) can't be held.
  const volNeeded = config.weighting === "inverseVol" ? (config.volLookback ?? 0) : 0;
  const barsNeeded = Math.max(1, volNeeded + 1);
  const tradable = (symbol: string): { ok: boolean; vol: number } => {
    if (view.barCount(symbol) < barsNeeded) return { ok: false, vol: 0 };
    const bars = priceHistory(view, symbol, barsNeeded);
    if (bars.length < barsNeeded || daysBetween(bars[bars.length - 1].date, asOf) > MAX_BAR_STALENESS_DAYS) return { ok: false, vol: 0 };
    if (config.weighting !== "inverseVol") return { ok: true, vol: 1 };
    const vol = trailingVol(bars.map(b => b.close), config.volLookback!);
    return vol !== null && vol > 0 ? { ok: true, vol } : { ok: false, vol: 0 };
  };
  const picks: Record<string, SessionDate> = {};
  const expired: string[] = [], dropped: string[] = [];
  // holdSessions counts the symbol's own bars after its selection (a halt stretches the hold, like a calendar of its own).
  const heldEnough = (symbol: string, since: SessionDate): boolean => config.holdSessions !== undefined
    ? priceHistory(view, symbol, config.holdSessions + 5).filter(b => b.date > since).length >= config.holdSessions
    : daysBetween(since, asOf) >= config.holdDays!;
  for (const symbol of Object.keys(prev.picks).sort(compareSymbols)) {
    if (heldEnough(symbol, prev.picks[symbol])) expired.push(symbol);
    else if (!tradable(symbol).ok) dropped.push(symbol);
    else picks[symbol] = prev.picks[symbol];
  }

  // 2. Events known by the cutoff (the view clips too; this keeps the kernel safe against a leaky view), not spent.
  const excluded = new Set(config.exclude);
  const members = input.membership ? new Set(input.membership.members(input.executionSession ?? asOf)) : null;
  const groups = new Map<string, Array<{ weight: number; actors: string[]; knownAtMs: number }>>();
  const filtered = { insiderClass: 0, plan10b5_1: 0, reportLag: 0 };
  const wantClass = config.insiderClass && config.insiderClass !== "all" ? config.insiderClass : null;
  let eventsSeen = 0;
  for (const e of signals.events(config.source, config.lookbackDays)) {
    if (e.source !== config.source || e.knownAtMs > cutoff) continue;
    if (excluded.has(e.symbol)) continue;
    if (config.roles && !hasRole(e.meta, config.roles)) continue;
    const spentAt = prev.spent[e.symbol];
    if (spentAt !== undefined && e.knownAtMs <= spentAt) continue;
    if (wantClass && e.meta.insiderClass !== wantClass) { filtered.insiderClass++; continue; }
    if (config.exclude10b5_1 && e.meta.plan10b5_1 === true) { filtered.plan10b5_1++; continue; }
    if (config.maxReportLagDays !== undefined && !(typeof e.meta.lagDays === "number" && e.meta.lagDays <= config.maxReportLagDays)) { filtered.reportLag++; continue; }
    eventsSeen++;
    const list = groups.get(e.symbol) ?? groups.set(e.symbol, []).get(e.symbol)!;
    list.push({ weight: Number.isFinite(e.weight) ? e.weight : 0, actors: actorsOf(e.meta), knownAtMs: e.knownAtMs });
  }
  const minPerInsider = config.minDollarPerInsider ?? 0;
  const candidates: CopyCandidate[] = [];
  for (const [symbol, evs] of groups) {
    // An actor counts only with its own dollars on the symbol; the cluster's dollars are those of the counted actors' events.
    const byActor = new Map<string, number>();
    for (const e of evs) for (const a of e.actors) byActor.set(a, (byActor.get(a) ?? 0) + e.weight);
    const counted = new Set([...byActor].filter(([, d]) => d >= minPerInsider).map(([a]) => a));
    const used = minPerInsider > 0 ? evs.filter(e => e.actors.some(a => counted.has(a))) : evs;
    const c: CopyCandidate = { symbol, insiders: counted.size, dollars: used.reduce((t, e) => t + e.weight, 0), events: used.length, lastKnownMs: used.reduce((m, e) => Math.max(m, e.knownAtMs), 0) };
    if (c.insiders >= config.minDistinctInsiders && c.dollars >= config.minDollar) candidates.push(c);
  }
  candidates.sort((a, b) => b.insiders - a.insiders || b.dollars - a.dollars || compareSymbols(a.symbol, b.symbol));

  // 3. Renew held names on fresh clusters; fill free slots in rank order (membership only gates NEW picks).
  const spent = { ...prev.spent };
  const renewed: string[] = [], added: string[] = [];
  for (const c of candidates) {
    if (picks[c.symbol] !== undefined) {
      picks[c.symbol] = asOf;
      spent[c.symbol] = cutoff;
      renewed.push(c.symbol);
      continue;
    }
    if (Object.keys(picks).length >= config.topN) continue;
    if (members && !members.has(c.symbol)) continue;
    if (!tradable(c.symbol).ok) continue;
    picks[c.symbol] = asOf;
    spent[c.symbol] = cutoff;
    added.push(c.symbol);
  }
  // Spent marks older than the lookback can no longer shadow any event in the window.
  for (const s of Object.keys(spent)) if (spent[s] < cutoff - config.lookbackDays * DAY_MS) delete spent[s];

  // 4. Weights: slot-sized gross, inverse-vol (or equal) inside it, per-name cap.
  const names = Object.keys(picks).sort(compareSymbols);
  const vols: Record<string, number> = {};
  for (const s of names) vols[s] = tradable(s).vol;
  const exposure = config.maxGross * Math.min(1, names.length / config.topN);
  const weights = cappedInverseVolWeights(vols, exposure, config.perNameCap);

  const memory: CopySignalMemory = { version: 1, picks: Object.fromEntries(names.map(s => [s, picks[s]])), spent };
  return { asOf, weights, stops: [], memory: { ...book.memory, [KEY]: memory },
    diagnostics: { candidates: candidates.map(c => ({ ...c })), picks: names, added, renewed, expired, dropped, eventsSeen, filtered, exposure, vols } };
}
