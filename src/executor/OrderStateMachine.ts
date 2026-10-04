// ══════════════════════════════════════════════
// OrderStateMachine — Wave 3c (2026-05-07)
// ══════════════════════════════════════════════
//
// Typed state machine for order lifecycle. Replaces ad-hoc string
// statuses scattered across executors with a single enum + validated
// transitions. Persists to the orders.state column.
//
// State graph:
//
//   SUBMITTING ──┬─→ OPEN ──┬─→ PARTIAL ──→ FILLED
//                │          ├─────────────→ CANCELED
//                │          ├─────────────→ EXPIRED
//                │          └─────────────→ REJECTED
//                ├─→ FILLED            (synchronous fill)
//                ├─→ REJECTED
//                └─→ FAILED            (network / pre-submit error)
//
// All terminal states (FILLED, CANCELED, REJECTED, FAILED, EXPIRED)
// have no outgoing transitions.

import { createLogger } from "../utils/logger";

const log = createLogger("OrderState");

export type OrderState =
  | "SUBMITTING"
  | "OPEN"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "FAILED"
  | "EXPIRED";

const ALLOWED_TRANSITIONS: Record<OrderState, ReadonlyArray<OrderState>> = {
  SUBMITTING: ["OPEN", "FILLED", "REJECTED", "FAILED"],
  OPEN:       ["PARTIAL", "FILLED", "CANCELED", "EXPIRED", "REJECTED"],
  PARTIAL:    ["PARTIAL", "FILLED", "CANCELED", "EXPIRED"],
  FILLED:     [],
  CANCELED:   [],
  REJECTED:   [],
  FAILED:     [],
  EXPIRED:    [],
};

/** Returns true if the (from → to) transition is permitted. */
export function isValidTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Best-effort mapping from broker-reported strings to our enum. Unknown
 * inputs return null so the caller can decide (typically: log warning,
 * leave state unchanged).
 */
export function fromBrokerStatus(s: string | undefined | null): OrderState | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "new" || lower === "accepted") return "OPEN";
  if (lower === "partially_filled" || lower === "partial_fill" ||
      lower === "partial_filled" || lower === "partial") return "PARTIAL";
  if (lower === "filled" || lower === "fill" || lower === "all_traded") return "FILLED";
  if (lower === "canceled" || lower === "cancelled") return "CANCELED";
  if (lower === "rejected" || lower === "reject") return "REJECTED";
  if (lower === "expired" || lower === "done_for_day") return "EXPIRED";
  if (lower === "pending" || lower === "submitting" || lower === "submitted") return "SUBMITTING";
  if (lower === "timeout_cancelled") return "CANCELED";
  return null;
}

/**
 * In-memory state tracker. Production usage: persist transitions via
 * `updateOrderStateFields` in db/database.ts after every accepted call.
 */
export class OrderStateMachine {
  private states: Map<string, OrderState> = new Map();

  current(orderId: string): OrderState | undefined {
    return this.states.get(orderId);
  }

  /**
   * Attempts a transition. Returns:
   *  - {ok: true} when the transition is valid OR when this is the
   *    first state we record for the order (any starting state).
   *  - {ok: false, from} when an invalid transition was attempted; the
   *    state is NOT modified.
   */
  transition(orderId: string, to: OrderState): { ok: boolean; from?: OrderState } {
    const from = this.states.get(orderId);
    if (from === undefined) {
      this.states.set(orderId, to);
      return { ok: true };
    }
    if (from === to && (to === "PARTIAL")) {
      // PARTIAL → PARTIAL is allowed for incremental fills.
      return { ok: true, from };
    }
    if (!isValidTransition(from, to)) {
      log.warn(`Invalid transition for ${orderId}: ${from} → ${to}`);
      return { ok: false, from };
    }
    this.states.set(orderId, to);
    return { ok: true, from };
  }

  /** Removes the order from in-memory state. Call when terminal + persisted. */
  forget(orderId: string): void {
    this.states.delete(orderId);
  }

  /** For tests / diagnostics. */
  size(): number {
    return this.states.size;
  }
}
