import type { DecideInput, SessionDate, TargetBook } from "./types";
import { cappedInverseVolWeights, covarianceFromPrices, scaleToVolTarget, selectCoreMembers } from "./construction";
import { compareSymbols, overlaySignal, priceHistory, trailingVol, trendSignal } from "./signals";
import { updateStops, type StopMemory } from "./stops";

/** Versioned, JSON-only state owned by this kernel; persist TargetBook.memory
 * unchanged. Separate strategy versions must not share this state. */
export interface CoreMemory {
  version: 1;
  signals: Record<string, boolean>;
  coreMonth?: string;
  coreMembers?: string[];
  overlayOn?: boolean;
  stops: StopMemory;
}

/** The base contract exposes only the last completed session. To reconstitute
 * at the FIRST EXECUTION session of a month (including exchange holidays), the
 * calendar-aware caller supplies that session here. This never advances the
 * PriceView beyond asOf; membership is the list effective at execution open.
 * Omitted: asOf-month and asOf-membership semantics.
 * Local extension until the director adds this field to the shared contract. */
export interface CoreDecideInput extends DecideInput {
  executionSession?: SessionDate;
}

function readMemory(input: DecideInput): CoreMemory {
  const value = input.book.memory.portfolioCore as CoreMemory | undefined;
  return value?.version === 1 ? value : { version: 1, signals: {}, stops: {} };
}

/** After executing deltas, callers may call decide again with ACTUAL positions,
 * the returned memory and the SAME view/executionSession. That refreshes stops
 * at the fill without exposing memory internals or using the fill day's close.
 * Persist the second memory and sync its stops; do not submit a second rebalance. */
export function decide(input: CoreDecideInput): TargetBook {
  const { view, config, book } = input;
  if (input.executionSession !== undefined && input.executionSession <= view.asOf) {
    throw new Error("executionSession must follow the last completed session");
  }
  const previous = readMemory(input);
  const memory: CoreMemory = { ...previous, signals: { ...previous.signals } };
  if (config.kind === "factorCore") {
    const month = (input.executionSession ?? view.asOf).slice(0, 7);
    const reconstituted = previous.coreMonth !== month || !previous.coreMembers;
    let scores: Record<string, number> = {};
    // First observed execution session of a month; cold start initializes now.
    if (reconstituted) {
      if (!input.membership) throw new Error("factorCore requires point-in-time membership at reconstitution");
      const selection = selectCoreMembers(view, input.membership, config, input.executionSession);
      memory.coreMonth = month;
      memory.coreMembers = selection.members;
      scores = selection.scores;
    }
    const vols: Record<string, number> = {};
    for (const s of memory.coreMembers ?? []) {
      const vol = trailingVol(priceHistory(view, s, config.weightVolLookback + 1).map(b => b.close), config.weightVolLookback);
      if (vol !== null && vol > 0) vols[s] = vol;
    }
    const overlay = overlaySignal(config.overlay ? priceHistory(view, config.overlay.ref, config.overlay.ma).map(b => b.close) : [],
      config.overlay, previous.overlayOn);
    memory.overlayOn = overlay.on;
    memory.stops = {};
    const weights = cappedInverseVolWeights(vols, overlay.exposure, config.perNameCap);
    return { asOf: view.asOf, weights, stops: [], memory: { ...book.memory, portfolioCore: memory },
      diagnostics: { reconstituted, coreMembers: memory.coreMembers, scores, vols, overlay, scale: 1 } };
  }

  const signals: Record<string, ReturnType<typeof trendSignal>> = {};
  const vols: Record<string, number> = {};
  const needed = Math.max(config.maLong, ...config.blendHorizons.map(h => h + 1), config.volLookback + 1, config.covLookback + 1);
  memory.signals = {};
  for (const s of [...new Set(config.universe)].sort(compareSymbols)) {
    if (view.barCount(s) < config.inceptionGuardBars) { memory.signals[s] = false; continue; }
    const closes = priceHistory(view, s, needed).map(b => b.close);
    const signal = trendSignal(closes, config, previous.signals[s]);
    signals[s] = signal;
    memory.signals[s] = signal.on;
    const vol = trailingVol(closes, config.volLookback);
    if (signal.on && vol !== null && vol > 0 && closes.length >= config.covLookback + 1) vols[s] = vol;
  }
  const covariance = covarianceFromPrices(view, Object.keys(vols), config.covLookback);
  const construction = scaleToVolTarget(vols, covariance, config.kind === "xassetTrend" ? 252 : 365,
    config.portfolioVolTarget, config.perAssetCap, config.maxGross);
  const stopState = updateStops(config.kind === "cryptoTrend" ? config.stop : { mode: "none" }, book.positions, view, previous.stops);
  memory.stops = stopState.memory;
  return { asOf: view.asOf, weights: construction.weights, stops: stopState.stops,
    memory: { ...book.memory, portfolioCore: memory }, diagnostics: { signals, vols, covariance,
      scale: construction.scale, uncappedVol: construction.uncappedVol, finalVol: construction.finalVol } };
}
