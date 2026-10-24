// RW5: optional price-regime and PIT-universe decisions. No I/O, shared by research/live.
import type { DailyBar, MembershipView, PriceView, RegimeOverlayConfig, RegimeSignal, VolManagedConfig } from "./types";
import { compareSymbols, priceHistory, trailingVol } from "./signals";
import { covarianceFromPrices, inverseVolWeights, portfolioVol } from "./construction";

export interface RegimeMemory {
  session: string;
  riskOff: boolean;
  signalOff: boolean[];
  pending: number;
  switched: boolean;
  ready: boolean;
}
export interface PitMemory {
  session: string;
  ages: Record<string, number>;
}

/** Tradable extras are separate from references: a signal-only holding is NEVER adopted by live. */
export function overlaySymbols(c: RegimeOverlayConfig, signals = true): string[] {
  const out = [...(c.defensive ? [...c.defensive.assets, c.defensive.cashProxy] : []), ...(c.hedge ? [c.hedge.symbol] : [])];
  if (signals) for (const s of c.signals) out.push(...(s.kind === "canary" ? s.assets : s.kind === "absMomentum" ? [s.symbol, s.cashProxy] : [s.symbol]));
  return [...new Set(out)].sort(compareSymbols);
}

/** Upper bound for daily bars needed by live's bounded loader (month-end: at most 31 per month). */
export function contingencyHistoryBars(c: VolManagedConfig): number {
  return Math.max(c.inceptionGuardBars, c.volLookback + 1, c.covLookback + 1, c.pitUniverse?.liquidityLookback ?? 0,
    ...(c.regimeOverlay?.signals.map(s => s.kind === "maTrend" ? s.sampling === "monthEnd" ? (s.period + 1) * 31 : s.period
      : s.kind === "absMomentum" ? s.lookback + 1 : Math.max(...s.horizons) + 1) ?? []),
    (c.regimeOverlay?.defensive?.momentumLookback ?? 0) + 1, (c.regimeOverlay?.defensive?.volLookback ?? 0) + 1);
}

function freshHistory(view: PriceView, symbol: string, n: number): readonly DailyBar[] {
  const bars = priceHistory(view, symbol, n);
  return bars.at(-1)?.date === view.asOf && bars.length >= n ? bars : [];
}

function trailingReturn(view: PriceView, symbol: string, n: number): number | null {
  const bars = freshHistory(view, symbol, n + 1);
  return bars.length ? bars.at(-1)!.close / bars[0].close - 1 : null;
}

function signalOff(view: PriceView, s: RegimeSignal, previous: boolean, executionSession?: string): boolean | null {
  if (s.kind === "maTrend") {
    let closes: number[];
    if (s.sampling === "daily") closes = freshHistory(view, s.symbol, s.period).map(b => b.close);
    else {
      // A month is complete ONLY when the caller's execution calendar is in the next month.
      // Without executionSession, exclude asOf's month. Never use an in-progress monthly close.
      const cutoff = (executionSession ?? view.asOf).slice(0, 7);
      const bars = priceHistory(view, s.symbol, (s.period + 1) * 31);
      if (bars.at(-1)?.date !== view.asOf) return null;
      const months = new Map<string, number>();
      for (const b of bars) if (b.date.slice(0, 7) < cutoff) months.set(b.date.slice(0, 7), b.close);
      const last = [...months].slice(-s.period);
      // Missing months are not a shorter horizon in disguise.
      const end = Date.parse(`${cutoff}-01T00:00:00Z`);
      if (last.length !== s.period || last.some(([m], i) => {
        const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - s.period + i);
        return m !== d.toISOString().slice(0, 7);
      })) return null;
      closes = last.map(([, close]) => close);
    }
    if (closes.length < s.period) return null;
    const sma = closes.reduce((a, b) => a + b, 0) / s.period;
    const distance = closes.at(-1)! / sma - 1;
    const band = (s.bandPct ?? 0) / 100;
    const epsilon = 8 * Number.EPSILON;
    return distance < -band - epsilon ? true : distance > band + epsilon ? false : previous;
  }
  if (s.kind === "absMomentum") {
    // Adjusted closes encode total returns. Compare IDENTICAL session endpoints/intervals.
    const a = freshHistory(view, s.symbol, s.lookback + 1), b = freshHistory(view, s.cashProxy, s.lookback + 1);
    if (!a.length || !b.length || a.some((bar, i) => bar.date !== b[i].date)) return null;
    return a.at(-1)!.close / a[0].close < b.at(-1)!.close / b[0].close;
  }
  let negatives = 0;
  for (const symbol of s.assets) {
    let score = 0;
    for (let i = 0; i < s.horizons.length; i++) {
      const r = trailingReturn(view, symbol, s.horizons[i]);
      if (r === null) return null;
      score += s.coefficients[i] * r;
    }
    if (score < 0) negatives++;
  }
  return negatives >= (s.negativeCount ?? 1);
}

export function decideRegime(view: PriceView, c: RegimeOverlayConfig, previous?: RegimeMemory, executionSession?: string): RegimeMemory {
  const session = executionSession ?? view.asOf;
  if (previous?.session === session) return previous; // post-fill refresh/retry is NOT another decision
  if (previous && session < previous.session) throw new Error("regimeOverlay decisions must be chronological");
  // Cold start risk-off. Missing/stale history retains state and resets confirmation (never counts as evidence).
  const results = c.signals.map((s, i) => signalOff(view, s, previous?.signalOff[i] ?? true, executionSession));
  const ready = results.every(v => v !== null);
  const votes = results.map((v, i) => v ?? previous?.signalOff[i] ?? true);
  const needed = c.combine === "any" ? 1 : c.combine === "all" ? votes.length : c.combine;
  const requested = votes.filter(Boolean).length >= needed;
  let riskOff = previous?.riskOff ?? true;
  let pending = ready && requested !== riskOff ? (previous?.pending ?? 0) + 1 : 0;
  const switched = pending >= (c.confirmationDecisions ?? 1);
  if (switched) { riskOff = requested; pending = 0; }
  return { session, riskOff, signalOff: votes, pending, switched, ready };
}

export function selectPitUniverse(view: PriceView, membership: MembershipView | undefined, c: VolManagedConfig, previous?: PitMemory, executionSession?: string): PitMemory {
  const p = c.pitUniverse!;
  const session = executionSession ?? view.asOf;
  if (previous?.session === session) return previous;
  if (previous && session < previous.session) throw new Error("pitUniverse decisions must be chronological");
  if (!membership) throw new Error("pitUniverse requires point-in-time membership");
  const excluded = new Set([...c.universe, ...(p.exclude ?? [])]);
  const scores: Record<string, number> = {};
  const needed = Math.max(p.liquidityLookback, c.volLookback + 1, c.covLookback + 1);
  // Membership is effective at execution open, like factorCore; every ranking input stops at asOf.
  for (const symbol of [...new Set(membership.members(session))].sort(compareSymbols)) {
    if (excluded.has(symbol) || view.barCount(symbol) < c.inceptionGuardBars) continue;
    const bars = freshHistory(view, symbol, needed);
    if (!bars.length || !(trailingVol(bars.map(b => b.close), c.volLookback)! > 0)) continue;
    const liquidity = bars.slice(-p.liquidityLookback);
    if (liquidity.some(b => !Number.isFinite(b.volume) || b.volume < 0)) continue;
    const score = liquidity.reduce((sum, b) => sum + b.close * b.volume, 0) / p.liquidityLookback;
    if (Number.isFinite(score) && score > 0) scores[symbol] = score;
  }
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a] || compareSymbols(a, b));
  const retained = ranked.filter(s => previous?.ages[s] !== undefined && previous.ages[s] < p.minHoldingRebalances);
  const selected = [...retained, ...ranked.filter(s => !retained.includes(s))].slice(0, p.topN).sort(compareSymbols);
  return { session, ages: Object.fromEntries(selected.map(s => [s, (previous?.ages[s] ?? 0) + 1])) };
}

/** Core target (before caps) → overlay → vol ceiling → asset cap → gross cap → vol ceiling.
 * Never relever after the overlay: otherwise coreScale would be undone. Recheck vol after clipping:
 * clipping a negatively-correlated hedge can INCREASE risk. No risk estimate for an action = fail closed. */
export function applyRegimeOverlay(view: PriceView, c: VolManagedConfig, core: Readonly<Record<string, number>>, riskOff: boolean, target: number) {
  const overlay = c.regimeOverlay!;
  const weights: Record<string, number> = { ...core };
  const coreGross = Object.values(core).reduce((a, b) => a + b, 0);
  const add = (s: string, w: number) => { if (w > 0) weights[s] = (weights[s] ?? 0) + w; };
  if (riskOff) {
    for (const s of Object.keys(weights)) weights[s] *= overlay.coreScale;
    if (overlay.defensive && coreGross > 0 && overlay.coreScale < 1) {
      const d = overlay.defensive;
      const vols: Record<string, number> = {};
      for (const s of d.assets) {
        const r = trailingReturn(view, s, d.momentumLookback);
        const bars = freshHistory(view, s, Math.max(d.volLookback, c.covLookback) + 1);
        const vol = trailingVol(bars.map(b => b.close), d.volLookback);
        if (r !== null && r > 0 && vol !== null && vol > 0) vols[s] = vol;
      }
      const defensive = Object.keys(vols).length ? inverseVolWeights(vols) : { [d.cashProxy]: 1 };
      for (const [s, w] of Object.entries(defensive)) add(s, w * coreGross * (1 - overlay.coreScale));
    }
    if (overlay.hedge) add(overlay.hedge.symbol, overlay.hedge.fraction * coreGross);
  }
  for (const s of Object.keys(weights)) if (!(weights[s] > 0)) delete weights[s];
  const symbols = Object.keys(weights).sort(compareSymbols);
  const histories = symbols.map(s => freshHistory(view, s, c.covLookback + 1));
  // Enough fresh history per symbol; a gap inside it is not fatal: covarianceFromPrices keeps only
  // the return intervals every symbol shares, exactly as the core construction does.
  const stale = symbols.filter((_, i) => histories[i].length < c.covLookback + 1);
  if (stale.length > 0) {
    throw new Error(`regimeOverlay requires fresh covariance history for every allocated symbol (asOf ${view.asOf}: ${stale.join(", ")})`);
  }
  const covariance = covarianceFromPrices(view, symbols, c.covLookback);
  const fast = c.fastVolLookback === undefined ? undefined : covarianceFromPrices(view, symbols, c.fastVolLookback);
  const risk = () => Math.max(portfolioVol(weights, covariance, c.annualization), fast ? portfolioVol(weights, fast, c.annualization) : 0);
  const uncappedVol = risk();
  const scale = uncappedVol > 0 ? Math.min(1, target / uncappedVol) : 1;
  for (const s of symbols) weights[s] = Math.min(c.perAssetCap, weights[s] * scale);
  const gross = Object.values(weights).reduce((a, b) => a + b, 0);
  if (gross > c.maxGross) for (const s of symbols) weights[s] *= c.maxGross / gross;
  const cappedVol = risk();
  if (cappedVol > target) for (const s of symbols) weights[s] *= target / cappedVol;
  return { weights, covariance, scale, uncappedVol, finalVol: portfolioVol(weights, covariance, c.annualization), coreGross };
}
