// ══════════════════════════════════════════════
// USDC (USDⓈ-M) / COIN-M (BTCUSD_PERP) certification script — 2026-07-19
// ══════════════════════════════════════════════
//
// Default: DRY RUN — runs each product's read-only preflight() only, prints
// a report, and NEVER places an order. Pass --execute to run the full cycle:
// preflight → refuse unless the account starts FLAT → open the minimum size
// → install a native stop → verify open → close → verify flat. Refuses
// --execute against anything but a testnet/demo host (the executors' own
// preflight() already enforces this; this script adds no separate override).
// Never logs API keys/secrets — only symbols, prices, quantities.
//
// Every mutation the script performs is tracked by its OWN exact
// order/client id; a try/finally around the cycle cancels/closes ONLY what
// THIS run created if a later step fails partway through — never a
// symbol-wide sweep, never touching state this run didn't create. The
// account must start flat (and, for COIN-M, with no cert-owned stop already
// tracked) or the whole run refuses before touching anything.
//
// This is the certification gate referenced by MOMENTUM_USDC_ENABLED /
// MOMENTUM_COINM_ENABLED in .env.example: run it with --execute on the SAME
// testnet keys before flipping either flag to true.
//
// Usage:
//   bun run scripts/certify-usdc-coinm.ts                       # dry-run (preflight only)
//   bun run scripts/certify-usdc-coinm.ts --execute              # full cycle, both products
//   bun run scripts/certify-usdc-coinm.ts --execute --product=usdc
//   bun run scripts/certify-usdc-coinm.ts --execute --product=coinm

import crypto from "crypto";
import { initDatabase } from "../src/db/database";
import { BinanceExecutor } from "../src/executor/binance-executor";
import { BinanceCoinMExecutor, computeContracts } from "../src/executor/binance-coinm-executor";
import { USDC_SYMBOL_MAP } from "../src/executor/binance/quoteAsset";

export const CERT_PRODUCTS = ["usdc", "coinm"] as const;
export type CertProduct = typeof CERT_PRODUCTS[number];

/** Absolute certification notional ceiling — a real testnet order is real
 *  money-shaped risk even when it's a minimum-size probe. Independent of
 *  (and on top of) minCertQty's own exchange-derived floor. */
export const CERT_MAX_NOTIONAL_USD = 200;

export function info(msg: string) { console.log(`[certify] ${msg}`); }
export function ok(msg: string) { console.log(`[certify] ✅ ${msg}`); }
export function fail(msg: string) { console.log(`[certify] ❌ ${msg}`); }

/** Validates --product against the known enum. Unknown value -> ok:false
 *  (caller exits nonzero) instead of silently running nothing. */
export function validateProductArg(arg: string | undefined): { ok: true; value: CertProduct | undefined } | { ok: false; reason: string } {
  if (arg === undefined) return { ok: true, value: undefined };
  if (!(CERT_PRODUCTS as readonly string[]).includes(arg)) {
    return { ok: false, reason: `unknown --product "${arg}" — expected one of: ${CERT_PRODUCTS.join(", ")}` };
  }
  return { ok: true, value: arg as CertProduct };
}

/** Validates the FULL argv, not just --product: any flag this script
 *  doesn't recognize is a hard failure (a typo like --exceute must never
 *  silently run a dry-run instead of the intended --execute cycle). */
export function validateArgs(args: string[]): { ok: true; execute: boolean; product: CertProduct | undefined } | { ok: false; reason: string } {
  let execute = false;
  let productArg: string | undefined;
  for (const arg of args) {
    if (arg === "--execute") { execute = true; continue; }
    if (arg.startsWith("--product=")) { productArg = arg.slice("--product=".length); continue; }
    return { ok: false, reason: `unknown argument "${arg}" — expected --execute or --product=<${CERT_PRODUCTS.join("|")}>` };
  }
  const validated = validateProductArg(productArg);
  if (!validated.ok) return validated;
  return { ok: true, execute, product: validated.value };
}

// ── COIN-M (BTCUSD_PERP) ────────────────────────────────────────

export async function certifyCoinM(exec: BinanceCoinMExecutor, execute: boolean): Promise<boolean> {
  info("── COIN-M (BTCUSD_PERP) ──");
  const pf = await exec.preflight();
  if (!pf.ok) { fail(`preflight: ${pf.reason}`); return false; }
  ok("preflight passed (testnet/demo, one-way, BTC balance row, exchangeInfo filters)");
  if (!execute) { ok("dry-run: stopping after preflight (pass --execute for the full open/close cycle)"); return true; }

  // skipStartupStopReconcile=true: the default init() MUTATES (it cancels
  // any owned reduceOnly stop it finds when the account reads flat). A
  // cert run must inspect REAL pre-existing broker state before touching
  // anything, so it opts out of that reconcile and does its own read-only
  // precheck below instead.
  if (!(await exec.init({ skipStartupStopReconcile: true }))) { fail("executor.init() failed after preflight passed"); return false; }

  const internalSymbol = "BTC/COIN-M";

  // Never touch pre-existing state: refuse the whole cycle unless the
  // account starts flat AND has zero owned reduceOnly stops for the product
  // — a REAL broker read (init() above deliberately skipped its own
  // mutating reconcile so this reflects actual state, not state it already
  // cleaned up out from under this check).
  const startPos = await exec.getOwnedPosition();
  if (startPos && startPos.positionAmt !== 0) {
    fail(`account is not flat before certification (${startPos.positionAmt} contracts already open) — refusing to touch pre-existing state`);
    return false;
  }
  const preExistingStops = await exec.listOwnedStops(internalSymbol);
  if (preExistingStops.length > 0) {
    fail(`${preExistingStops.length} pre-existing reduceOnly stop(s) already on ${internalSymbol} before certification — refusing to run on top of leftover/foreign state`);
    return false;
  }

  const filters = await exec.getFilters(internalSymbol, { forceRefresh: true });
  // Certification's explicit minimum-size probe — the ONLY caller allowed to
  // floor a sub-one-contract notional up to a full contract (a live caller
  // must never do this; see computeContracts).
  const contracts = computeContracts(1, filters.contractSize, { allowMinimumFloor: true });
  const runId = `certify_${Date.now()}`;

   let opened = false;
   // The EXACT quantity THIS run opened — never re-derived from "whatever the
   // broker currently shows", which could include a concurrent addition from
   // outside this run. Every close (happy-path and cleanup) is capped to this
   // number so certification can never touch more than it created.
   let openedContracts = 0;
   let stopInstalled = false;
   let cleanupFailed = false;
   try {
    const order = await exec.placeMarketOrder({ internalSymbol, side: "buy", contracts, intentId: `open_${runId}` });
    if (!order) { fail("placeMarketOrder returned null (never confirmed FILLED)"); return false; }
    if (!(order.executedQty > 0)) { fail("placeMarketOrder confirmed without a positive executedQty — cannot determine the cert-owned quantity"); return false; }
    opened = true;
    openedContracts = order.executedQty;
    ok(`opened ${openedContracts} contracts @ ${order.avgPrice} (clientOrderId=${order.clientOrderId})`);

    const stopPrice = order.avgPrice * 0.96;
    const stop = await exec.placeStopMarketClose(internalSymbol, "buy", stopPrice, openedContracts, `stop_${runId}`);
    if (!stop.ok) { fail("native STOP_MARKET install failed — closing anyway, do not leave a real position unmonitored"); return false; }
    stopInstalled = true;
    ok(`native STOP_MARKET installed @ ${stopPrice.toFixed(filters.pricePrecision)} (${stop.kind} ${stop.id})`);

    const live = await exec.getOwnedPosition();
    if (!live || live.positionAmt === 0) { fail("position not found on broker after a confirmed fill"); return false; }
    if (Math.abs(live.positionAmt) !== openedContracts) {
      fail(`broker position (${live.positionAmt}) does not match the ${openedContracts} contracts this run opened — a concurrent position change is suspected; refusing to close anything beyond what this run created`);
      return false; // finally cleanup below closes ONLY openedContracts, never the extra
    }
    ok(`verified open: ${live.positionAmt} contracts`);

     const close = await exec.closePosition(internalSymbol, openedContracts, "buy", `close_${runId}`);
     if (!close.success) { fail("close did not confirm — position may still be open, verify manually"); return false; }
     if (close.executedQty !== openedContracts) {
       fail(`close only reduced ${close.executedQty}/${openedContracts} cert-owned contracts — a remnant may still be open, VERIFY MANUALLY`);
       return false;
     }
     ok(`closed @ ${close.filledPrice}`);

     // SAFETY: do NOT set opened=false or cancel the stop yet. First perform
     // an exact broker reread to confirm the position is actually flat.
     let after: any;
     try {
       after = await exec.getOwnedPosition();
     } catch (e: any) {
       fail(`reread after close failed (${e.message}) — position state unknown, stop retained, MANUAL RECONCILE REQUIRED`);
       return false;
     }
     if (after && after.positionAmt !== 0) {
       fail(`reread shows still open (${after.positionAmt}) after close — stop retained, MANUAL RECONCILE REQUIRED`);
       return false;
     }
     ok("verified flat");

     // Only after confirmed flat: cancel the cert-owned stop
     const cancelled = await exec.cancelActiveStop(internalSymbol);
     if (!cancelled) { fail("cancelActiveStop reported failure after close — verify manually"); return false; }
     stopInstalled = false;
     opened = false; // reduceOnly close confirmed exact and flat — nothing left for the finally cleanup to close

     return true;
  } finally {
    // Post-submit failure cleanup: NEVER cancel the cert-owned stop before
    // confirming the position is flat. Cleanup order: (1) read exact owned
    // position successfully; (2) close at most cert-owned delta while stop
    // remains; (3) reread successfully and confirm flat/original state; (4)
    // only then cancel cert-owned stop. If close/reread fails, retain stop
    // and fail loud/manual reconcile.
    if (opened) {
      let live: any;
      try {
        live = await exec.getOwnedPosition();
      } catch (e: any) {
        fail(`cleanup: position read failed (${e.message}) — unknown state, stop retained, MANUAL RECONCILE REQUIRED`);
        cleanupFailed = true;
      }
      if (!cleanupFailed && live && live.positionAmt !== 0) {
        const closeQty = Math.min(openedContracts, Math.abs(live.positionAmt));
        if (Math.abs(live.positionAmt) > openedContracts) {
          fail(`cleanup: broker position (${live.positionAmt}) exceeds the ${openedContracts} contracts this run opened — closing ONLY the cert-owned ${closeQty}, never a concurrent addition; the remainder is NOT this run's and is left untouched`);
        }
        let closed: any;
        try {
          closed = await exec.closePosition(internalSymbol, closeQty, live.positionAmt > 0 ? "buy" : "sell", `cleanup_${runId}`);
        } catch (e: any) {
          fail(`cleanup: emergency close failed (${e.message}) — stop retained, MANUAL RECONCILE REQUIRED`);
          cleanupFailed = true;
        }
        if (!cleanupFailed && !closed?.success) {
          fail("cleanup: emergency close did not confirm — stop retained, MANUAL RECONCILE REQUIRED");
          cleanupFailed = true;
        }
        if (!cleanupFailed && closed.executedQty < closeQty) {
          fail(`cleanup: only closed ${closed.executedQty}/${closeQty} cert-owned contracts — stop retained, MANUAL RECONCILE REQUIRED`);
          cleanupFailed = true;
        }
        // Close succeeded — now reread to confirm flat before canceling stop
        if (!cleanupFailed) {
          let after: any;
          try {
            after = await exec.getOwnedPosition();
          } catch (e: any) {
            fail(`cleanup: reread after close failed (${e.message}) — stop retained, MANUAL RECONCILE REQUIRED`);
            cleanupFailed = true;
          }
          if (!cleanupFailed && after && after.positionAmt !== 0) {
            fail(`cleanup: reread shows still open (${after.positionAmt}) after close — stop retained, MANUAL RECONCILE REQUIRED`);
            cleanupFailed = true;
          }
          if (!cleanupFailed) {
            info(`cleanup: cert-owned position closed after a post-submit failure (${closed.executedQty} contracts)`);
          }
        }
      }
    }
    // Only cancel the stop AFTER confirming the position is flat
    if (!cleanupFailed && stopInstalled) {
      try {
        const cancelled = await exec.cancelActiveStop(internalSymbol);
        if (!cancelled) {
          fail("cleanup: cancelActiveStop reported failure — a cert-owned stop may still be live, VERIFY MANUALLY");
        } else {
          info("cleanup: cert-owned native stop canceled after a post-submit failure");
          stopInstalled = false;
        }
      } catch (e: any) {
        fail(`cleanup: cancelActiveStop threw (${e.message}) — a cert-owned stop may still be live, VERIFY MANUALLY`);
      }
    }
  }
  return false;
}

// ── USDC (USDⓈ-M) ───────────────────────────────────────────────

// Same seed -> same id, always (mirrors binance-coinm-executor.ts's
// deterministic-client-id pattern, own namespace since USDⓈ-M and COIN-M
// are different products/executors). Lets the run prove an order/stop it
// finds afterward is the ONE IT PLACED — never a diff-based "whatever
// appeared" guess, which a concurrent submitter could poison.
const USDC_CERT_CLIENT_ID_NAMESPACE = "uc-cert-usdc-";
const CLIENT_ID_MAX_LEN = 36; // Binance clientOrderId/clientAlgoId cap
function deterministicCertClientId(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, CLIENT_ID_MAX_LEN - USDC_CERT_CLIENT_ID_NAMESPACE.length);
  return `${USDC_CERT_CLIENT_ID_NAMESPACE}${hash}`;
}

/**
 * Reads pending native orders + algo (conditional) orders for `nativeSymbol`
 * via the executor's own private signedRequest seam — BinanceExecutor
 * exposes no public "list my orders" method, and this script deliberately
 * does NOT widen the FAPI executor's API just to serve a cert script (cast
 * to `any` here instead). Real DAPI/FAPI shapes: `/fapi/v1/openOrders`
 * returns a plain array; `/fapi/v1/openAlgoOrders` also returns a plain
 * array (see BinanceExecutor.cancelAllOrders), defensively unwrapped here
 * too in case a future response wraps it in `{ orders: [] }`.
 *
 * Throws on a read failure or a malformed (non-array) response — a read
 * error is UNKNOWN state, never "no pending orders". The old behavior
 * (`.catch(() => [])`) silently treated a transport failure as a flat
 * account and let the run proceed on top of state it never actually saw.
 */
async function snapshotPendingOrders(execAny: any, nativeSymbol: string): Promise<{ orders: any[]; algoOrders: any[] }> {
  const orders = await execAny.signedRequest("GET", "/fapi/v1/openOrders", { symbol: nativeSymbol });
  if (!Array.isArray(orders)) throw new Error(`openOrders read for ${nativeSymbol} returned a non-array response`);
  const algoRaw = await execAny.signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: nativeSymbol });
  const algoOrders = Array.isArray(algoRaw) ? algoRaw : (Array.isArray(algoRaw?.orders) ? algoRaw.orders : null);
  if (algoOrders === null) throw new Error(`openAlgoOrders read for ${nativeSymbol} returned a non-array response`);
  return { orders, algoOrders };
}

/** The order/algo entry (if any) carrying `clientId` in a pending-order
 *  snapshot — ownership by exact deterministic id, never a before/after
 *  diff (which a concurrent submitter's own order could poison). */
function findOwnedStop(snap: { orders: any[]; algoOrders: any[] }, clientId: string): { orderId?: string; algoId?: string } {
  const order = snap.orders.find((o) => String(o?.clientOrderId ?? "") === clientId);
  const algo = snap.algoOrders.find((o) => String(o?.clientAlgoId ?? "") === clientId);
  return { orderId: order ? String(order.orderId) : undefined, algoId: algo ? String(algo.algoId) : undefined };
}

/**
 * Reads the EXACT order THIS run submitted, by its deterministic
 * origClientOrderId — never `placeOrder`'s own return value (null on a
 * poll timeout even though the order later filled) and never an
 * aggregate/broker position read (which could include foreign exposure).
 * Bounded retries cover a transient read hiccup; returns null (not thrown)
 * when the order genuinely can't be read — callers must treat null as
 * "no proof of a fill", never as "no fill occurred".
 */
async function queryExactOrder(execAny: any, nativeSymbol: string, clientOrderId: string): Promise<{ orderId: string; executedQty: number; avgPrice: number; status: string } | null> {
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const o = await execAny.signedRequest("GET", "/fapi/v1/order", { symbol: nativeSymbol, origClientOrderId: clientOrderId });
      return { orderId: String(o.orderId), executedQty: parseFloat(o.executedQty) || 0, avgPrice: parseFloat(o.avgPrice) || 0, status: String(o.status ?? "") };
    } catch (e: any) {
      if (i === ATTEMPTS - 1) {
        fail(`exact order read for ${clientOrderId} failed after ${ATTEMPTS} attempts (${e.message})`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return null;
}

/** Binance order states that will never mutate again. NEW/PARTIALLY_FILLED
 *  (and anything unrecognized) are treated as non-terminal — the ONLY safe
 *  default, since a status this script has never seen must never be
 *  silently assumed done. */
const TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "EXPIRED", "REJECTED", "EXPIRED_IN_MATCH"]);

/** True ONLY for Binance's "this order id/clientOrderId does not exist"
 *  responses (-2011 on cancel, -2013 on query, sometimes surfaced without a
 *  numeric `.code` when the transport wraps an HTTP 4xx) — the single case
 *  where a failed cancel/query legitimately means "nothing to reconcile
 *  under this id". Every other error is a transport hiccup or an unknown
 *  failure mode and must fail loud instead of being guessed away. */
function isUnknownOrderError(e: any): boolean {
  if (e?.code === -2011 || e?.code === -2013) return true;
  return /unknown order|order does not exist/i.test(String(e?.message ?? ""));
}

/**
 * Cancels the EXACT order this run owns — by orderId when known, else by
 * origClientOrderId — and confirms it reached a TERMINAL state before the
 * caller is allowed to look at executedQty or flatness. Binance's own
 * cancel response echoes the order's final fields; trusted directly when it
 * already reports terminal, otherwise one bounded exact requery covers the
 * rare case it doesn't (e.g. still shows PENDING_CANCEL). Distinct outcomes
 * so the caller never has to guess:
 *  - "absent": Binance confirmed no order exists under this id (unknown-order).
 *  - "terminal": canceled and confirmed terminal; `final` carries the exact
 *    post-cancel executedQty/avgPrice/status.
 *  - "ambiguous": cancel/requery failed for any OTHER reason, or the order
 *    is STILL non-terminal after the bounded requery — caller must fail
 *    loud (MANUAL RECONCILE), never assume/close/sweep anything.
 */
async function cancelExactAndConfirmTerminal(
  execAny: any, nativeSymbol: string, ids: { orderId?: string; clientOrderId: string }
): Promise<{ outcome: "absent" | "terminal" | "ambiguous"; final?: { orderId: string; executedQty: number; avgPrice: number; status: string } }> {
  const cancelParams: Record<string, string> = ids.orderId
    ? { symbol: nativeSymbol, orderId: ids.orderId }
    : { symbol: nativeSymbol, origClientOrderId: ids.clientOrderId };
  let delResp: any;
  try {
    delResp = await execAny.signedRequest("DELETE", "/fapi/v1/order", cancelParams);
  } catch (e: any) {
    if (isUnknownOrderError(e)) return { outcome: "absent" };
    fail(`exact cancel for ${ids.orderId ?? ids.clientOrderId} failed ambiguously (${e.message})`);
    return { outcome: "ambiguous" };
  }
  const delStatus = String(delResp?.status ?? "");
  if (TERMINAL_ORDER_STATUSES.has(delStatus)) {
    return { outcome: "terminal", final: { orderId: String(delResp?.orderId ?? ids.orderId ?? ""), executedQty: parseFloat(delResp?.executedQty) || 0, avgPrice: parseFloat(delResp?.avgPrice) || 0, status: delStatus } };
  }
  // Delete response didn't confirm terminal on its own — one bounded exact
  // requery before giving up (never trust a non-terminal delete response).
  const requeried = await queryExactOrder(execAny, nativeSymbol, ids.clientOrderId);
  if (requeried && TERMINAL_ORDER_STATUSES.has(requeried.status)) {
    return { outcome: "terminal", final: requeried };
  }
  fail(`exact cancel for ${ids.orderId ?? ids.clientOrderId} did not confirm a terminal state (delete status=${delStatus || "?"}, requery status=${requeried?.status ?? "unreadable"})`);
  return { outcome: "ambiguous" };
}

/** Deletes ONLY the exact cert-owned order/algo id(s) — never a symbol-wide
 *  sweep (cancelAllOrders). A no-op when `owned` carries neither id. */
async function cancelOwnedStop(execAny: any, nativeSymbol: string, owned: { orderId?: string; algoId?: string }): Promise<boolean> {
  let allOk = true;
  if (owned.orderId) {
    try { await execAny.signedRequest("DELETE", "/fapi/v1/order", { symbol: nativeSymbol, orderId: owned.orderId }); }
    catch (e: any) { fail(`cleanup: DELETE /fapi/v1/order ${owned.orderId} failed: ${e.message}`); allOk = false; }
  }
  if (owned.algoId) {
    try { await execAny.signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: nativeSymbol, algoId: owned.algoId }); }
    catch (e: any) { fail(`cleanup: DELETE /fapi/v1/algoOrder ${owned.algoId} failed: ${e.message}`); allOk = false; }
  }
  return allOk;
}

export async function certifyUsdc(exec: BinanceExecutor, execute: boolean): Promise<boolean> {
  info("── USDC (USDⓈ-M) ──");
  const pf = await exec.preflight();
  if (!pf.ok) { fail(`preflight: ${pf.reason}`); return false; }
  ok("preflight passed (testnet, one-way, single-asset margin, USDC balance row, exchangeInfo filters)");
  if (!execute) { ok("dry-run: stopping after preflight (pass --execute for the full open/close cycle)"); return true; }

  if (!(await exec.init())) { fail("executor.init() failed after preflight passed"); return false; }

  const internalSymbol = "BTC/USDC";
  const nativeSymbol = USDC_SYMBOL_MAP[internalSymbol];
  const execAny = exec as any;

  // Never touch pre-existing state: refuse unless the exact symbol starts flat.
  const startPositions = await exec.getPositions();
  const preExisting = startPositions.find(p => p.symbol === nativeSymbol);
  if (preExisting && preExisting.positionAmt !== 0) {
    fail(`account is not flat before certification (${preExisting.positionAmt} ${nativeSymbol} already open) — refusing to touch pre-existing state`);
    return false;
  }

  // Preflight-read pending native/algo orders for this symbol — a REAL,
  // RELIABLE broker read (never a swallowed-to-[] guess). Refuse the whole
  // run if anything is already pending or the read itself is unreliable.
  let preOrders: { orders: any[]; algoOrders: any[] };
  try {
    preOrders = await snapshotPendingOrders(execAny, nativeSymbol);
  } catch (e: any) {
    fail(`pending order snapshot read failed before certification (${e.message}) — refusing to run without a reliable pre-state read`);
    return false;
  }
  if (preOrders.orders.length > 0 || preOrders.algoOrders.length > 0) {
    fail(`${preOrders.orders.length} pending order(s) / ${preOrders.algoOrders.length} pending algo order(s) already on ${nativeSymbol} before certification — refusing to run on top of leftover/foreign state`);
    return false;
  }

  const price = await exec.getPrice(nativeSymbol);
  if (!(price > 0)) { fail(`no price for ${nativeSymbol}`); return false; }

  const signal = {
    id: "certify", symbol: internalSymbol, market: "crypto" as const, side: "buy" as const,
    strategy: "MOMENTUM" as any, strength: "strong" as any, price, timestamp: Date.now(),
    indicators: {} as Record<string, number>, reason: "certification minimum open",
  };
  // Exchange-derived minimum — clears both MARKET_LOT_SIZE.minQty and
  // MIN_NOTIONAL from cached exchangeInfo (a hardcoded "$20 / price" guess
  // silently under-shot BTCUSDC's real $100 MIN_NOTIONAL). placeOrder's own
  // pre-flight filters remain the final validator regardless.
  const requestedQty = await exec.minCertQty(internalSymbol, price);
  if (requestedQty == null) {
    fail(`could not compute a minimum certification quantity for ${internalSymbol} (no exchangeInfo spec or invalid price)`);
    return false;
  }
  // Explicit absolute ceiling — a belt-and-suspenders check independent of
  // minCertQty's own exchange-derived floor. Refuses BEFORE placeOrder is
  // ever called, never after.
  const requestedNotional = requestedQty * price;
  if (!Number.isFinite(requestedNotional) || !(requestedNotional > 0) || requestedNotional > CERT_MAX_NOTIONAL_USD) {
    fail(`certification notional $${Number.isFinite(requestedNotional) ? requestedNotional.toFixed(2) : requestedNotional} for ${internalSymbol} is outside the safety range (0, $${CERT_MAX_NOTIONAL_USD}] — refusing before placing any order`);
    return false;
  }
  info(`minimum certification size: ${requestedQty} ${nativeSymbol} (~$${requestedNotional.toFixed(2)} notional @ $${price})`);
  const runId = `certify_${Date.now()}`;
  const openClientId = deterministicCertClientId(`open:${runId}`);
  const stopClientId = deterministicCertClientId(`stop:${runId}`);

   let opened = false;
   // The EXACT quantity THIS run opened — never re-derived from "whatever
   // the broker currently shows", which could include a concurrent addition
   // from outside this run. Every close (happy-path and cleanup) is capped
   // to this number so certification can never touch more than it created.
   let openedQty = 0;
   // The cert-owned stop's exact order/algo id, proven via `stopClientId` —
   // never a before/after diff. Cleared once canceled so the finally block
   // never double-cancels on the happy path.
   let ownedStop: { orderId?: string; algoId?: string } = {};
   let cleanupFailed = false;
   try {
    const order = await exec.placeOrder(signal, requestedQty, "momentum_crypto_usdc", { clientOrderId: openClientId });
    // Ownership is decided EXCLUSIVELY by rereading the EXACT order this run
    // submitted (origClientOrderId=openClientId) — never placeOrder's own
    // return value (null on a poll timeout even though the order later
    // filled) and never an aggregate/broker position read (could include
    // foreign exposure). A NON-TERMINAL exact read (NEW/PARTIALLY_FILLED —
    // e.g. placeOrder gave up polling before the exchange settled it) is
    // never trusted for its executedQty as-is: it's canceled by its EXACT
    // orderId and confirmed terminal first, so a still-resting remainder
    // can never be left unmonitored and a still-filling partial can never
    // be under-counted.
    let finalOrder: { orderId: string; executedQty: number; avgPrice: number; status: string } | null;
    const initial = await queryExactOrder(execAny, nativeSymbol, openClientId);
    if (initial === null) {
      // Initial exact read failed outright. Attempt an exact cancel by
      // origClientOrderId (no orderId known yet), but do not treat an
      // unknown-order response plus a currently-flat position as proof that
      // no fill can appear later. Only a positively terminal order is safe.
      const cancelResult = await cancelExactAndConfirmTerminal(execAny, nativeSymbol, { clientOrderId: openClientId });
      if (cancelResult.outcome !== "terminal") {
        fail(`exact order read for ${openClientId} failed and the exact cancel did not prove a terminal order — ambiguous state, MANUAL RECONCILE REQUIRED, refusing to touch anything further`);
        return false;
      }
      finalOrder = cancelResult.final!;
    } else if (!TERMINAL_ORDER_STATUSES.has(initial.status)) {
      const cancelResult = await cancelExactAndConfirmTerminal(execAny, nativeSymbol, { orderId: initial.orderId, clientOrderId: openClientId });
      if (cancelResult.outcome !== "terminal") {
        fail(`exact order ${initial.orderId} (${initial.status}) could not be confirmed terminal after an exact cancel — MANUAL RECONCILE REQUIRED, refusing to touch anything further`);
        return false;
      }
      finalOrder = cancelResult.final!;
    } else {
      finalOrder = initial; // already terminal (FILLED/CANCELED/EXPIRED/REJECTED) — no cancel needed
    }
    if (!finalOrder || !(finalOrder.executedQty > 0)) {
      // No exact proof this run filled anything, and any resting remainder
      // is already confirmed canceled above. Flat -> nothing to reconcile,
      // fail clean. Non-flat -> exposure exists without exact proof of
      // ownership; never close/cancel it (could be foreign).
      const positions = await exec.getPositions();
      const live = positions.find(p => p.symbol === nativeSymbol);
      if (live && live.positionAmt !== 0) {
        fail(`no exact fill confirmed for ${openClientId}, but the broker is NOT flat (${live.positionAmt} ${nativeSymbol}) — refusing to touch ambiguous/foreign exposure, MANUAL RECONCILE REQUIRED`);
        return false;
      }
      fail(`no exact fill confirmed for ${openClientId} — account is flat, nothing to reconcile`);
      return false;
    }
    opened = true;
    openedQty = finalOrder.executedQty;
    const openFillPrice = finalOrder.avgPrice > 0 ? finalOrder.avgPrice : (order?.filledPrice ?? price);
    ok(`opened ${openedQty} ${nativeSymbol} @ $${openFillPrice} (orderId=${finalOrder.orderId}, clientOrderId=${openClientId})`);

    const stopPrice = openFillPrice * 0.96;
    const stopOk = await exec.placeStopMarketClose(internalSymbol, "buy", stopPrice, openedQty, stopClientId);
    if (!stopOk) { fail("native STOP_MARKET install failed — closing anyway, do not leave a real position unmonitored"); return false; }

    // "ok" from placeStopMarketClose is not enough — require the stop to be
    // NEWLY VISIBLE and carry OUR client id before trusting it protects
    // anything (a success response that never actually reached the book is
    // as dangerous as no stop at all).
    let postStopSnapshot: { orders: any[]; algoOrders: any[] };
    try {
      postStopSnapshot = await snapshotPendingOrders(execAny, nativeSymbol);
    } catch (e: any) {
      fail(`pending order snapshot read failed after stop install (${e.message}) — cannot verify the stop is cert-owned, refusing to proceed`);
      return false;
    }
    ownedStop = findOwnedStop(postStopSnapshot, stopClientId);
    if (!ownedStop.orderId && !ownedStop.algoId) {
      fail("native STOP_MARKET reported success but no cert-owned order/algo with our client id is visible in the pending snapshot — refusing to proceed unprotected");
      return false;
    }
    ok(`native STOP_MARKET installed @ $${stopPrice.toFixed(2)} (verified visible: ${ownedStop.orderId ? `order ${ownedStop.orderId}` : `algo ${ownedStop.algoId}`})`);

    const positions = await exec.getPositions();
    const live = positions.find(p => p.symbol === nativeSymbol);
    if (!live || live.positionAmt === 0) { fail("position not found on broker after a confirmed fill"); return false; }
    if (Math.abs(live.positionAmt) !== openedQty) {
      fail(`broker position (${live.positionAmt}) does not match the ${openedQty} ${nativeSymbol} this run opened — a concurrent position change is suspected; refusing to close anything beyond what this run created`);
      return false; // finally cleanup below closes ONLY openedQty, never the extra
    }
    ok(`verified open: ${live.positionAmt} ${nativeSymbol}`);

     // Order-level cleanup (allOpenOrders sweep + algo enumeration) is
     // skipped here — this run's stop is a single exact-id, cancelled below
     // ONLY after flatness is positively confirmed, never a symbol-wide sweep.
     const close = await exec.closePosition(internalSymbol, openedQty, "buy", { skipOrderCleanup: true });
     if (!close.success) { fail("close did not confirm — position may still be open, verify manually"); return false; }
     const closedQty = close.filledQty ?? openedQty;
     if (closedQty !== openedQty) {
       fail(`close only reduced ${closedQty}/${openedQty} cert-owned ${nativeSymbol} — a remnant may still be open, VERIFY MANUALLY`);
       return false;
     }
     ok(`closed @ $${close.filledPrice}`);

     // SAFETY: do NOT set opened=false or cancel the stop yet. First perform
     // an exact broker reread to confirm the position is actually flat.
     let after: any[];
     try {
       after = await exec.getPositions();
     } catch (e: any) {
       fail(`reread after close failed (${e.message}) — position state unknown, stop retained, MANUAL RECONCILE REQUIRED`);
       return false;
     }
     if (after.some(p => p.symbol === nativeSymbol && p.positionAmt !== 0)) {
       fail(`reread shows still open after close — stop retained, MANUAL RECONCILE REQUIRED`);
       return false;
     }
     ok("verified flat");

     // Only after confirmed flat: cancel the cert-owned stop
     const cancelled = await cancelOwnedStop(execAny, nativeSymbol, ownedStop);
     if (!cancelled) { fail("cleanup: exact order/algo cancel failed — a cert-owned stop may still be live, VERIFY MANUALLY"); return false; }
     ownedStop = {};
     opened = false; // reduceOnly close confirmed exact and flat — nothing left for the finally cleanup to close

     return true;
  } finally {
    // Post-submit failure cleanup: NEVER cancel the cert-owned stop before
    // confirming the position is flat. Cleanup order: (1) read exact owned
    // positions successfully; (2) close at most cert-owned delta while stop
    // remains; (3) reread successfully and confirm flat/original state; (4)
    // only then cancel cert-owned stop. If close/reread fails, retain stop
    // and fail loud/manual reconcile.
    if (opened) {
      let positions: any[];
      try {
        positions = await exec.getPositions();
      } catch (e: any) {
        fail(`cleanup: positions read failed (${e.message}) — unknown state, stop retained, MANUAL RECONCILE REQUIRED`);
        cleanupFailed = true;
      }
      if (!cleanupFailed) {
        const live = positions.find(p => p.symbol === nativeSymbol);
        if (live && live.positionAmt !== 0) {
          const closeQty = Math.min(openedQty, Math.abs(live.positionAmt));
          if (Math.abs(live.positionAmt) > openedQty) {
            fail(`cleanup: broker position (${live.positionAmt}) exceeds the ${openedQty} ${nativeSymbol} this run opened — closing ONLY the cert-owned ${closeQty}, never a concurrent addition; the remainder is NOT this run's and is left untouched`);
          }
          let closed: any;
          try {
            closed = await exec.closePosition(internalSymbol, closeQty, live.positionAmt > 0 ? "buy" : "sell", { skipOrderCleanup: true });
          } catch (e: any) {
            fail(`cleanup: emergency close failed (${e.message}) — stop retained, MANUAL RECONCILE REQUIRED`);
            cleanupFailed = true;
          }
          if (!cleanupFailed && !closed?.success) {
            fail("cleanup: emergency close did not confirm — stop retained, MANUAL RECONCILE REQUIRED");
            cleanupFailed = true;
          }
          if (!cleanupFailed) {
            const closedQty = closed.filledQty ?? closeQty;
            if (closedQty < closeQty) {
              fail(`cleanup: only closed ${closedQty}/${closeQty} cert-owned ${nativeSymbol} — stop retained, MANUAL RECONCILE REQUIRED`);
              cleanupFailed = true;
            }
          }
          // Close succeeded — now reread to confirm flat before canceling stop
          if (!cleanupFailed) {
            let after: any[];
            try {
              after = await exec.getPositions();
            } catch (e: any) {
              fail(`cleanup: reread after close failed (${e.message}) — stop retained, MANUAL RECONCILE REQUIRED`);
              cleanupFailed = true;
            }
            if (!cleanupFailed && after.some(p => p.symbol === nativeSymbol && p.positionAmt !== 0)) {
              fail(`cleanup: reread shows still open after close — stop retained, MANUAL RECONCILE REQUIRED`);
              cleanupFailed = true;
            }
            if (!cleanupFailed) {
              const closedQty = closed.filledQty ?? closeQty;
              info(`cleanup: cert-owned position closed after a post-submit failure (${closedQty} ${nativeSymbol})`);
            }
          }
        }
      }
    }
    // Only cancel the stop AFTER confirming the position is flat
    if (!cleanupFailed && (ownedStop.orderId || ownedStop.algoId)) {
      try {
        const cancelled = await cancelOwnedStop(execAny, nativeSymbol, ownedStop);
        if (!cancelled) {
          fail("cleanup: exact order/algo cancel failed — a cert-owned stop may still be live, VERIFY MANUALLY");
        } else {
          info("cleanup: cert-owned order/algo id(s) canceled after a post-submit failure");
          ownedStop = {};
        }
      } catch (e: any) {
        fail(`cleanup: exact order/algo cancel threw (${e.message}) — a cert-owned stop may still be live, VERIFY MANUALLY`);
      }
    }
  }
  return false;
}

// ── Entry point ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const validated = validateArgs(args);
  if (!validated.ok) { fail(validated.reason); process.exit(1); }
  const EXECUTE = validated.execute;
  const runUsdc = !validated.product || validated.product === "usdc";
  const runCoinm = !validated.product || validated.product === "coinm";

  initDatabase("./data/trading.db");
  info(EXECUTE ? "MODE: --execute (will place real testnet orders)" : "MODE: dry-run (preflight only, no orders)");

  let allOk = true;
  if (runUsdc) allOk = (await certifyUsdc(new BinanceExecutor({ quoteAsset: "USDC" }), EXECUTE).catch((e: any) => { fail(`USDC certification crashed: ${e.message}`); return false; })) && allOk;
  if (runCoinm) allOk = (await certifyCoinM(new BinanceCoinMExecutor(), EXECUTE).catch((e: any) => { fail(`COIN-M certification crashed: ${e.message}`); return false; })) && allOk;

  console.log(allOk ? "\n[certify] ALL CHECKS PASSED" : "\n[certify] SOME CHECKS FAILED — see above");
  process.exit(allOk ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e: any) => { console.error(`[certify] fatal: ${e.message}`); process.exit(1); });
}
