#!/usr/bin/env bun
// ══════════════════════════════════════════════
// Reconcile ORPHAN Binance FAPI exposure (P0, 2026-08-19)
//
// An "orphan" is broker exposure in EXCESS of our open DB rows for a symbol:
// rows closed as MANUAL_CLOSE / MANUAL_CLOSE_UNRECONCILED whose real broker
// position was never closed (root cause: momentum_crypto's stops fill as
// −4120 algo orders invisible to hasFilledStopClose → mislabeled closes; see
// BinanceSleeveReconciler.ts algoOrderStopAttribution). The residue consumes
// margin and blocked new entries ("Margin is insufficient", prod 2026-08-19:
// broker LINKUSDT 785.75 vs tracked row 198 → 587.75 LINK / ~$6.1k orphaned).
//
// The live reconciler can NEVER fix this shape: its orphan phase is
// symbol-level (any open row for the symbol blocks adoption) and its
// flat-row phase only looks at fully-flat symbols. Hence this script.
//
// Semantics (NON-NEGOTIABLE):
//   - DRY-RUN by default. Only `--apply` transmits anything.
//   - Closes ONLY the orphan delta = brokerAbs − min(Σ our rows, brokerAbs)
//     (the tracked share is bounded by scripts/lib/boundedCloseQty.ts — the
//     same guardrail close-all-positions.ts uses, here protecting the
//     KEEP side instead of the close side). The tracked position and its
//     DB rows are NEVER touched.
//   - A FULLY-untracked symbol (no row of ours at all) is reported and
//     SKIPPED: that's the live reconciler's protect-then-adopt territory,
//     not ours to guess at.
//   - FAIL-CLOSED: the broker position and the tracked rows are re-read
//     immediately before the close; ANY drift vs the printed plan aborts
//     that symbol instead of guessing.
//   - Idempotent: everything derives from fresh reads — a second run finds
//     orphan=0 and does nothing.
//   - Verifies AFTER: broker position must equal the tracked rows (±lot
//     tolerance), printed per symbol.
//   - After a verified orphan close, reduceOnly STOP orders on that symbol
//     that match NO tracked row's quantity are stale leftovers of the
//     orphan (e.g. the 192.57 @ 8.238 LINK stop from the 11-Aug row) — left
//     alive they would fire AGAINST the tracked position. They are canceled
//     by exact orderId/algoId; anything matching a tracked row is kept.
//
// Scope: the two linear FAPI sleeves (USDT + USDC). COIN-M is single-symbol
// with executor-side ownership (getOwnedPosition) — censused separately and
// clean on 2026-08-20 (broker 6 = tracked 6).
//
// Usage:  bun scripts/reconcile-orphan-exposure.ts            # dry-run
//         bun scripts/reconcile-orphan-exposure.ts --apply    # execute
// ══════════════════════════════════════════════

import { boundedCryptoCloseQty, type OpenTradeRowLike } from "./lib/boundedCloseQty";

/** Quantities are broker lot-step aligned; anything below this is rounding. */
export const QTY_EPS = 1e-8;

export interface BrokerPositionLike {
  symbol: string;        // native, e.g. "LINKUSDT"
  positionAmt: number;   // signed
  entryPrice: number;
  unrealizedProfit: number;
}

export interface OrphanPlan {
  internalSymbol: string;
  brokerSymbol: string;
  side: "buy" | "sell";      // position side; closePosition inverts it
  brokerAbs: number;         // |positionAmt| at plan time
  trackedQty: number;        // Σ our open non-shadow rows (bounded)
  orphanQty: number;         // brokerAbs − trackedQty → what we close
  markPrice: number;         // recovered from entry + uPnL/amt (display only)
  orphanNotionalUsd: number; // orphanQty × mark (display only)
}

export interface PlanResult {
  plans: OrphanPlan[];
  /** Symbols reported but NOT planned (fully untracked / unmapped). */
  skipped: { brokerSymbol: string; reason: string }[];
}

/**
 * Pure planning: one pass over the broker positions of ONE executor
 * (quote-asset scoped), against our open non-shadow crypto rows.
 * `toInternal` is the executor's own symbol translation.
 */
export function planOrphanCloses(
  openRows: OpenTradeRowLike[],
  brokerPositions: BrokerPositionLike[],
  toInternal: (native: string) => string | null,
): PlanResult {
  const plans: OrphanPlan[] = [];
  const skipped: PlanResult["skipped"] = [];
  for (const p of brokerPositions) {
    const brokerAbs = Math.abs(p.positionAmt);
    if (!(brokerAbs > 0)) continue;
    const internal = toInternal(p.symbol);
    if (!internal) {
      skipped.push({ brokerSymbol: p.symbol, reason: "no internal symbol mapping — not ours to manage" });
      continue;
    }
    // min(Σ our rows, brokerAbs): the KEEP side. Never close into it.
    const trackedQty = boundedCryptoCloseQty(openRows, internal, brokerAbs);
    const orphanQty = brokerAbs - trackedQty;
    if (orphanQty <= QTY_EPS) continue; // fully tracked (or broker < rows) — nothing orphaned
    if (trackedQty === 0) {
      skipped.push({ brokerSymbol: p.symbol, reason: `fully untracked (${brokerAbs}) — live reconciler's protect-then-adopt territory, skipped` });
      continue;
    }
    const mark = p.positionAmt !== 0 ? p.entryPrice + p.unrealizedProfit / p.positionAmt : p.entryPrice;
    plans.push({
      internalSymbol: internal,
      brokerSymbol: p.symbol,
      side: p.positionAmt > 0 ? "buy" : "sell",
      brokerAbs,
      trackedQty,
      orphanQty,
      markPrice: mark,
      orphanNotionalUsd: orphanQty * (Number.isFinite(mark) && mark > 0 ? mark : p.entryPrice),
    });
  }
  return { plans, skipped };
}

export interface ApplyDeps {
  /** Fresh |positionAmt| for the native symbol, straight from the broker. */
  readBrokerAbs(brokerSymbol: string): Promise<number>;
  /** Fresh Σ of our open non-shadow rows for the internal symbol. */
  readTrackedQty(internalSymbol: string): Promise<number>;
  /** reduceOnly market close of `qty` against the `side` position. */
  closePosition(internalSymbol: string, qty: number, side: "buy" | "sell"): Promise<{ success: boolean; filledPrice: number }>;
}

export interface ApplyResult {
  ok: boolean;
  aborted?: string;          // fail-closed reason; nothing was transmitted
  closeFailed?: string;      // close transmitted but not confirmed — VERIFY MANUALLY
  filledPrice?: number;
  remainingAfter?: number;   // fresh broker read after the close
  verified?: boolean;        // remainingAfter === trackedQty (±QTY_EPS·scale)
}

/**
 * Fail-closed execution of ONE plan:
 *   re-read broker + rows → any drift vs the plan aborts → close ONLY the
 *   orphan delta → re-read → verify remaining == tracked.
 * Running it twice can never close more: the second run's re-read no longer
 * matches the stale plan and aborts (and a fresh plan finds orphan=0).
 */
export async function applyOrphanClose(deps: ApplyDeps, plan: OrphanPlan): Promise<ApplyResult> {
  const tol = Math.max(QTY_EPS, plan.brokerAbs * 1e-9);
  const freshAbs = await deps.readBrokerAbs(plan.brokerSymbol);
  if (Math.abs(freshAbs - plan.brokerAbs) > tol) {
    return { ok: false, aborted: `broker qty moved: plan=${plan.brokerAbs} fresh=${freshAbs} — market changed under us, re-run to re-plan` };
  }
  const freshTracked = await deps.readTrackedQty(plan.internalSymbol);
  if (Math.abs(freshTracked - plan.trackedQty) > tol) {
    return { ok: false, aborted: `tracked rows changed: plan=${plan.trackedQty} fresh=${freshTracked} — the bot traded under us, re-run to re-plan` };
  }

  const result = await deps.closePosition(plan.internalSymbol, plan.orphanQty, plan.side);
  if (!(result.success && result.filledPrice > 0)) {
    return { ok: false, closeFailed: `close not confirmed (success=${result.success}, filledPrice=${result.filledPrice}) — VERIFY BROKER STATE MANUALLY before re-running` };
  }

  const remainingAfter = await deps.readBrokerAbs(plan.brokerSymbol);
  const verified = Math.abs(remainingAfter - plan.trackedQty) <= tol;
  return { ok: true, filledPrice: result.filledPrice, remainingAfter, verified };
}

/** A stale stop is a reduceOnly STOP whose qty matches NO tracked row (and
 *  not the tracked total). qty=0 (closePosition-style whole-position stops)
 *  is KEPT — it can't be attributed to the orphan with certainty. */
export function isStaleOrphanStop(
  order: { quantity: number; reduceOnly: boolean; type: string },
  trackedRowQtys: number[],
): boolean {
  if (!order.reduceOnly || !order.type.toUpperCase().includes("STOP")) return false;
  if (!(order.quantity > 0)) return false;
  const total = trackedRowQtys.reduce((a, b) => a + b, 0);
  const matches = (q: number) => Math.abs(order.quantity - q) <= Math.max(QTY_EPS, q * 1e-6);
  return !trackedRowQtys.some(matches) && !matches(total);
}

// ══════════════════════════════════════════════
// Live wiring (only when executed directly, never on import/test)
// ══════════════════════════════════════════════

async function main() {
  const APPLY = process.argv.includes("--apply");
  const { Database } = await import("bun:sqlite");
  const crypto = await import("crypto");
  const { config } = await import("../src/config");
  const { BinanceExecutor, isNonProductionBinanceHost } = await import("../src/executor/binance-executor");

  if (!isNonProductionBinanceHost(config.binanceFutures.restBase)) {
    console.error("✗ REFUSING: Binance restBase is not a known sandbox (testnet/demo) host.");
    process.exit(2);
  }
  console.log(`▌ Mode: ${APPLY ? "APPLY (will transmit reduceOnly closes)" : "DRY-RUN (read-only)"}\n`);

  const db = new Database("./data/trading.db", { readonly: true });
  const openRows = (): OpenTradeRowLike[] => db.prepare(
    `SELECT symbol, market, quantity, account_id FROM trades WHERE status='open' AND market='crypto'`
  ).all() as any[];

  // Direct signed FAPI call for the stale-stop store (list + targeted cancel).
  async function fapi(method: string, path: string, params: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
    const sig = crypto.createHmac("sha256", config.binanceFutures.apiSecret).update(qs).digest("hex");
    const r = await fetch(`${config.binanceFutures.restBase}${path}?${qs}&signature=${sig}`, {
      method, headers: { "X-MBX-APIKEY": config.binanceFutures.apiKey },
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`${method} ${path} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  let anyFailure = false;

  for (const quoteAsset of ["USDT", "USDC"] as const) {
    console.log(`━━ FAPI ${quoteAsset} sleeve ━━`);
    const exec = new BinanceExecutor({ quoteAsset });
    if (!(await exec.init())) {
      console.error(`✗ ${quoteAsset} executor failed to init — skipping (NOT verified clean)`);
      anyFailure = true;
      continue;
    }
    const positions = await exec.getPositions();
    const { plans, skipped } = planOrphanCloses(openRows(), positions, s => exec.toInternalSymbol(s));

    for (const s of skipped) console.log(`  • ${s.brokerSymbol}: ${s.reason}`);
    if (plans.length === 0) {
      console.log(`  ✓ no orphan exposure (every broker position matches its tracked rows)\n`);
      continue;
    }

    for (const plan of plans) {
      console.log(`  ORPHAN ${plan.brokerSymbol}: broker=${plan.brokerAbs} tracked=${plan.trackedQty}`);
      console.log(`    → will close ${plan.orphanQty} (${plan.side === "buy" ? "SELL" : "BUY"} reduceOnly, ~$${plan.orphanNotionalUsd.toFixed(2)} @ mark ~${plan.markPrice.toFixed(4)})`);
      console.log(`    → will remain ${plan.trackedQty} (the tracked position — NEVER touched)`);
      if (!APPLY) continue;

      const res = await applyOrphanClose({
        readBrokerAbs: async (sym) => Math.abs((await exec.getPositions()).find(p => p.symbol === sym)?.positionAmt ?? 0),
        readTrackedQty: async (internal) => boundedCryptoCloseQty(openRows(), internal, Number.POSITIVE_INFINITY),
        closePosition: async (internal, qty, side) => {
          // skipOrderCleanup: closePosition's partial-close path cancels ALL
          // uc-stamped stops on the symbol (binance-executor.ts:1519-1530,
          // "clear only our stamped stops" — designed for the case where OUR
          // row's share closed). Here the tracked row KEEPS its position, so
          // that sweep would strip its protective stop too (it did, live
          // 2026-08-20: the LINK apply canceled the tracked 198 @ 9.11 stop,
          // re-armed manually). The targeted stale-only cleanup below is the
          // correct one for this script's semantics.
          const r = await exec.closePosition(internal, qty, side, { skipOrderCleanup: true });
          return { success: r.success, filledPrice: r.filledPrice };
        },
      }, plan);

      if (res.aborted) { console.error(`    ✗ ABORTED (fail-closed): ${res.aborted}`); anyFailure = true; continue; }
      if (res.closeFailed) { console.error(`    ✗ ${res.closeFailed}`); anyFailure = true; continue; }
      console.log(`    ✓ closed ${plan.orphanQty} @ $${res.filledPrice!.toFixed(4)}`);
      console.log(`    ${res.verified ? "✓ VERIFIED" : "✗ NOT VERIFIED"}: broker now ${res.remainingAfter} vs tracked ${plan.trackedQty}`);
      if (!res.verified) { anyFailure = true; continue; }

      // Stale-stop cleanup: cancel reduceOnly stops that belonged to the orphan.
      try {
        const rowQtys = openRows().filter(t => t.symbol === plan.internalSymbol && !(t.account_id ?? "").startsWith("shadow_")).map(t => t.quantity);
        const [regular, algoRaw] = await Promise.all([
          fapi("GET", "/fapi/v1/openOrders", { symbol: plan.brokerSymbol }),
          fapi("GET", "/fapi/v1/openAlgoOrders", { symbol: plan.brokerSymbol }),
        ]);
        const algo = Array.isArray(algoRaw) ? algoRaw : (algoRaw?.orders ?? []);
        for (const o of regular) {
          const shaped = { quantity: Number(o.origQty ?? 0), reduceOnly: o.reduceOnly === true || String(o.reduceOnly) === "true", type: String(o.type ?? "") };
          if (!isStaleOrphanStop(shaped, rowQtys)) continue;
          console.log(`    ✂ canceling stale stop (regular) qty=${shaped.quantity} trigger=${o.stopPrice} orderId=${o.orderId}`);
          await fapi("DELETE", "/fapi/v1/order", { symbol: plan.brokerSymbol, orderId: String(o.orderId) });
        }
        for (const o of algo) {
          const shaped = { quantity: Number(o.totalQty ?? o.origQty ?? o.quantity ?? 0), reduceOnly: o.reduceOnly === true || String(o.reduceOnly) === "true", type: String(o.orderType ?? o.type ?? "") };
          if (!isStaleOrphanStop(shaped, rowQtys)) continue;
          console.log(`    ✂ canceling stale stop (algo) qty=${shaped.quantity} trigger=${o.triggerPrice ?? o.stopPrice} algoId=${o.algoId}`);
          await fapi("DELETE", "/fapi/v1/algoOrder", { symbol: plan.brokerSymbol, algoId: String(o.algoId) });
        }
      } catch (e: any) {
        console.error(`    ⚠ stale-stop cleanup failed (position is already reconciled; stops need manual review): ${e.message}`);
        anyFailure = true;
      }
    }
    console.log("");
  }

  // Final census so the after-state is on the record.
  console.log(`━━ Post-run census ━━`);
  for (const quoteAsset of ["USDT", "USDC"] as const) {
    const exec = new BinanceExecutor({ quoteAsset });
    if (!(await exec.init())) continue;
    const { plans, skipped } = planOrphanCloses(openRows(), await exec.getPositions(), s => exec.toInternalSymbol(s));
    console.log(`  ${quoteAsset}: ${plans.length === 0 && skipped.length === 0 ? "✓ clean — broker == tracked rows on every symbol" : `${plans.length} orphan(s), ${skipped.length} skipped — see above`}`);
  }
  db.close();
  if (!APPLY) console.log(`\nDry-run only. Re-run with --apply to execute the plan above.`);
  process.exit(anyFailure ? 1 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error("Fatal:", e); process.exit(1); });
}
