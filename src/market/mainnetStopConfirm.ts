// ══════════════════════════════════════════════
// Mainnet confirmation for Binance TESTNET stop closes (2026-08-11)
// ══════════════════════════════════════════════
//
// Why this exists (OPEN.md P1, incident 2026-07-20 07:45): momentum_crypto
// closed LINK as STOP_LOSS at 7.8181 (−1.73% from entry, stop was at 7.638 =
// −4%) while MAINNET LINK traded 8.29–8.36 that hour and the low of the
// entire 12→29 Jul hold was 7.788 — the trigger price NEVER existed on real
// markets. Root cause is an origin asymmetry: SIGNALS use mainnet klines
// (binanceKlines.ts → fapi.binance.com) but EXECUTION and the price the
// client-side stop evaluates come from the TESTNET, whose thin book prints
// prices with no real-world counterpart. Measured band of that noise (30d of
// parallel 5m candles): BTC diverged >0.5% on 1.19% of bars; ETH's testnet
// low printed as much as −1.81% below mainnet's. Our stop sits at −4% from
// entry — well inside reach of a testnet-only excursion.
//
// The fix: before the bot itself executes a STOP close on Binance, confirm
// against the public MAINNET mark price (same host binanceKlines.ts and
// FundingMonitor already use, no key, weight 1) that real data ALSO breaches
// the stop. Shape deliberately follows src/market/plausibility.ts: pure
// predicate + observe/enforce env switch here; the caller (binance-executor)
// owns the network seam, the rate limiter and the logging. This module never
// touches the signal path (already mainnet) nor the broker-native
// STOP_MARKET (Binance's own trigger, doesn't pass through us).
//
// FAIL-OPEN, not fail-closed — the inverse of plausibility.ts, deliberately.
// plausibility rejects a dubious price READ: the safe failure is "no price".
// Here a rejection BLOCKS a protective close: the safe failure is "close
// anyway". This repo's hard invariant is that an open position is never left
// unmanaged; coupling the stop of last resort to the availability of a third
// endpoint would convert every mainnet outage into an unprotected position.
// So: only POSITIVE evidence of disagreement (a valid mainnet price that
// does NOT breach the stop) can reject; no response / bad response / bad
// inputs ⇒ "unavailable" ⇒ the caller proceeds exactly as today. The
// residual risk (ghost testnet print DURING a mainnet outage) is the
// intersection of two rare events, and the 15s stop loop re-evaluates
// continuously, so a transient outage delays a real stop by seconds — it
// never disables it.

import { fetchT } from "../utils/timeout";

/** Public production FAPI host — real prices, no auth (same constant as
 *  FundingMonitor/binanceKlines; kept local so this module stays free of
 *  their side effects). */
export const MAINNET_FAPI = "https://fapi.binance.com";

// ── observe/enforce switch ────────────────────────────────────────────────
// Default OBSERVE — conservative with respect to CURRENT production
// behavior: every verdict is computed and counted, nothing is blocked. Flip
// BINANCE_STOP_CONFIRM_MODE=enforce once the observed would-block rate on
// live data looks right (see STOP_CONFIRM_WOULD_BLOCK in the executor).
export type StopConfirmMode = "observe" | "enforce";

export function stopConfirmMode(raw: string | undefined = process.env.BINANCE_STOP_CONFIRM_MODE): StopConfirmMode {
  return raw === "enforce" ? "enforce" : "observe";
}

/** Stop context a caller attaches to a Binance close that was TRIGGERED by
 *  the client-side stop check (AccountManager.checkAllStopLoss). Engine
 *  rebalance exits never pass this — they are intentional regardless of
 *  price and must not be gated. */
export type StopCloseConfirm = {
  /** Our own entry fill — the anchor both stop checks share. */
  entryPrice: number;
  /** profile.stopLossPct (positive, e.g. 4 for a −4% stop). */
  stopLossPct: number;
  /** The testnet price that fired the trigger — logging/telemetry only. */
  triggerPrice?: number;
};

export type StopConfirmConfig = {
  /** Slack in percentage POINTS subtracted from stopLossPct when re-testing
   *  the stop on the mainnet price: confirm when mainnet pnl% ≤
   *  −(stopLossPct − slackPct). Never more than half the stop itself. */
  slackPct: number;
};

export const DEFAULT_STOP_CONFIRM: StopConfirmConfig = {
  // 0.5pp: covers the measured legitimate testnet-vs-mainnet noise (BTC
  // diverged >0.5% on only 1.19% of 5m bars) plus the read skew between the
  // testnet mark (up to ~15s old from the stop loop) and the mainnet read
  // made moments later. A real crash where both venues track confirms with
  // mainnet still 0.5pp shy of the stop; the LINK ghost (mainnet ≈ +4.2%
  // from entry vs a −4% stop) misses confirmation by ~7.7pp — three orders
  // of magnitude outside this slack.
  slackPct: 0.5,
};

export type StopConfirmVerdict =
  /** Mainnet agrees the stop is breached (within slack) — close. */
  | { kind: "confirmed"; mainnetPnlPct: number }
  /** Valid mainnet price does NOT breach the stop — the trigger was a
   *  testnet-only print. Enforce mode blocks; observe mode counts. */
  | { kind: "rejected"; mainnetPnlPct: number; detail: string }
  /** No usable mainnet price / corrupt inputs — cannot judge. Caller MUST
   *  fail open (proceed with the close). */
  | { kind: "unavailable"; reason: string };

/** Pure predicate: would this stop ALSO fire on the mainnet price?
 *  pnl% formula ≡ database.ts pnlOf's pct for qty>0 (Δprice/entry×100,
 *  side-signed) — recomputed inline so this module stays dependency-free
 *  like plausibility.ts. Bad inputs are "unavailable", NOT "rejected":
 *  unlike plausibility's fail-closed reads, blocking a protective close on
 *  our own corrupt bookkeeping would be the worse failure. */
export function checkStopAgainstMainnet(
  args: { side: "buy" | "sell"; entryPrice: number; stopLossPct: number; mainnetPrice: number },
  cfg: StopConfirmConfig = DEFAULT_STOP_CONFIRM,
): StopConfirmVerdict {
  const { side, entryPrice, stopLossPct, mainnetPrice } = args;
  if (!Number.isFinite(mainnetPrice) || mainnetPrice <= 0) {
    return { kind: "unavailable", reason: `no mainnet price (got ${mainnetPrice})` };
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { kind: "unavailable", reason: `bad entryPrice=${entryPrice}` };
  }
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0) {
    return { kind: "unavailable", reason: `bad stopLossPct=${stopLossPct}` };
  }
  const mainnetPnlPct = side === "buy"
    ? ((mainnetPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - mainnetPrice) / entryPrice) * 100;
  const slack = Math.min(Math.max(cfg.slackPct, 0), stopLossPct / 2);
  if (mainnetPnlPct <= -(stopLossPct - slack)) return { kind: "confirmed", mainnetPnlPct };
  return {
    kind: "rejected",
    mainnetPnlPct,
    detail: `mainnet ${mainnetPrice} ⇒ ${mainnetPnlPct.toFixed(2)}% from entry ${entryPrice}, stop −${stopLossPct}% (slack ${slack}pp) not breached on real data`,
  };
}

/** MAINNET mark price for a native symbol ("LINKUSDT") via public
 *  premiumIndex (weight 1) — the mainnet counterpart of the testnet
 *  markPrice the stop evaluated, so the comparison is apples-to-apples.
 *  Returns 0 on ANY failure (timeout, HTTP error, bad payload): 0 maps to
 *  "unavailable" in checkStopAgainstMainnet ⇒ fail-open at the caller.
 *  The caller is responsible for the rate-limiter acquire (protect class)
 *  BEFORE invoking this. */
export async function fetchMainnetMarkPrice(nativeSymbol: string, fetchFn: typeof fetchT = fetchT): Promise<number> {
  try {
    const res = await fetchFn(`${MAINNET_FAPI}/fapi/v1/premiumIndex?symbol=${nativeSymbol}`, {}, 4_000);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    const row = Array.isArray(data) ? data.find((r: any) => r?.symbol === nativeSymbol) : data;
    const price = parseFloat(row?.markPrice);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch {
    return 0;
  }
}
