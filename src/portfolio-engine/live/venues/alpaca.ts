// ═══ Portfolio engine — Alpaca venue (stocks / ETFs, fractional) ═══
//
// A VenueAdapter over the existing Alpaca executor and its v3-shaped client
// (alpaca-v5-compat). What it does, and what it deliberately does not:
//   - fractional MARKET DAY orders (the executor's placeOrder rounds to whole
//     shares — that is why orders go to the client here, with the same
//     duplicate-client_order_id handling the executor uses);
//   - client_order_id idempotency: a 422 naming the field means the order
//     already exists → query it by client id, never resend;
//   - a fill that is still working after `fillTimeoutMs` cancels the
//     REMAINDER by order id (cancelOrder) and reports what filled. NEVER a
//     full-position DELETE /v2/positions/{symbol}: that liquidates the
//     account's aggregate (AGENTS.md "Alpaca close semantics") and this bot's
//     two stock sleeves share one wallet;
//   - positions and latest prices read through the executor (its limiter,
//     its cache, its symbol normalization);
//   - rules: fractional, min notional 5 USD (RW manifest), band from the design.
//   - buys mirror the shared account's Reg-T buying power pre-submit, exactly as the
//     incumbent engines do (AlpacaMomentumAdapter, 2026-08-20): the sleeve ledger sizes the
//     order, the account's margin buying power is the cross-sleeve truth, an unreadable
//     value fails OPEN. Sells are never guarded. The treasury sweep (BOXX) needs nothing
//     else: cash simply goes negative on margin until its 15:50 cover sells the ETF;
//   - releaseLegacyStops: cancel the incumbent's resting GTC stops on adopted symbols;
//   - syncStops: not provided — D1/D2 declare no stops; the engine alerts if a
//     design ever declares one on this venue.

import type { AlpacaExecutor } from "../../../executor/alpaca-executor";
import { createLogger } from "../../../utils/logger";
import type { LegacyStopRelease, OrderIntent, OrderResult, Position, VenueAdapter, VenueRules } from "../../types";

const log = createLogger("PortfolioVenue:alpaca");

/** Q5: shared-account headroom below overnight Reg-T (live execution only). */
export const ALPACA_ACCOUNT_MAX_GROSS = 1.9;

/** The raw v3-shaped client surface this venue needs (alpaca-v5-compat). */
export interface AlpacaVenueClient {
  createOrder(params: Record<string, unknown>): Promise<any>;
  getOrder(orderId: string): Promise<any>;
  getOrderByClientId(clientOrderId: string): Promise<any>;
  cancelOrder(orderId: string): Promise<void>;
}

/** The executor surface this venue reads (positions, prices, connectivity). */
export interface AlpacaVenueExecutor {
  isConnected(): boolean;
  getPositions(): Promise<Array<{ symbol: string; market: string; side: string; quantity: number; avgEntryPrice: number; currentPrice: number }>>;
  getLatestPrice(symbol: string): Promise<number>;
  getCachedPrice?(symbol: string): number;
  /** Account Reg-T buying power (null = unreadable). Absent = no guard (fails open). */
  getRegTBuyingPower?(): Promise<number | null>;
  /** Whole account, including the other sleeve, manual holdings and treasury. */
  getAccount?(): Promise<{ equity?: unknown; long_market_value?: unknown } | null>;
  /** Cutover: this bot's resting stop orders (uc8- stamped only), and a targeted cancel by id. */
  getOpenStopOrders?(symbol?: string): Promise<Array<{ id: string; clientOrderId: string; symbol: string; side: string }>>;
  cancelOrderById?(orderId: string): Promise<boolean>;
}

export interface AlpacaVenueOptions {
  minOrderNotional?: number;
  rebalanceBand?: number;
  /** How long a market order may keep working before the remainder is cancelled. */
  fillTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Settle wait after a cancel before the final read. */
  settleMs?: number;
  /** releaseLegacyStops: total bounded wait for the cancels to be confirmed terminal (default 20 s). */
  releaseConfirmTimeoutMs?: number;
  releasePollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const ALPACA_TERMINAL_STATUSES = new Set(["filled", "canceled", "expired", "rejected", "done_for_day", "replaced", "stopped", "suspended"]);
const DUPLICATE_CLIENT_ORDER_ID_RE = /client[_ -]?order[_ -]?id/i;
/** Alpaca accepts up to 9 decimals on fractional qty. */
export function formatFractionalQty(qty: number): string {
  return qty.toFixed(9).replace(/\.?0+$/, "");
}

export class AlpacaVenue implements VenueAdapter {
  readonly venue = "alpaca" as const;
  private readonly sleep: (ms: number) => Promise<void>;
  // E1 and E2 share this executor: serialize buys THROUGH settlement so both cannot spend
  // the same headroom. Sells remain unguarded; research and other venues never use this.
  private static readonly buys = new WeakMap<AlpacaVenueExecutor, Promise<void>>();

  constructor(
    private readonly executor: AlpacaVenueExecutor,
    private readonly client: AlpacaVenueClient,
    private readonly opts: AlpacaVenueOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  /** Production constructor: the executor's own v3-shaped client (one
   *  connection per venue — the same instance BrokerSync and the adapters
   *  reuse). The client is a private field of AlpacaExecutor by design; it is
   *  read here through a checked accessor rather than widening the executor
   *  (the only Alpaca surface the portfolio engine needs that the executor
   *  does not expose is a fractional market order). */
  static fromExecutor(executor: AlpacaExecutor, opts: AlpacaVenueOptions = {}): AlpacaVenue {
    const client = (executor as unknown as { client?: AlpacaVenueClient }).client;
    if (!client || typeof client.createOrder !== "function" || typeof client.getOrderByClientId !== "function") {
      throw new Error("AlpacaVenue.fromExecutor: executor has no v3-shaped client (createOrder/getOrderByClientId)");
    }
    return new AlpacaVenue(executor, client, opts);
  }

  async rules(_symbols: readonly string[]): Promise<VenueRules> {
    return {
      venue: "alpaca",
      fractional: true,
      minOrderNotional: this.opts.minOrderNotional ?? 5,
      rebalanceBand: this.opts.rebalanceBand ?? 0,
    };
  }

  async positions(symbols: readonly string[]): Promise<Position[]> {
    if (!this.executor.isConnected()) throw new Error("alpaca not connected");
    const want = new Set(symbols);
    const out: Position[] = [];
    for (const p of await this.executor.getPositions()) {
      if (p.market !== "stock" || !want.has(p.symbol)) continue;
      if (p.side !== "buy") { log.warn(`${p.symbol}: short broker position ignored (long-only sleeve)`); continue; }
      if (!(p.quantity > 0)) continue;
      out.push({ symbol: p.symbol, qty: p.quantity, avgEntryPrice: p.avgEntryPrice });
    }
    return out;
  }

  async prices(symbols: readonly string[]): Promise<Record<string, number>> {
    if (!this.executor.isConnected()) throw new Error("alpaca not connected");
    const out: Record<string, number> = {};
    let marks: Map<string, number> | null = null;
    for (const s of new Set(symbols)) {
      let px = this.executor.getCachedPrice?.(s) ?? 0;
      if (!(px > 0)) {
        try { px = await this.executor.getLatestPrice(s); } catch (e: any) { log.debug(`latest price ${s}: ${e?.message ?? e}`); }
      }
      if (!(px > 0)) {
        // Broker mark (positions' current_price), 24/7 — Alpaca marks for Alpaca symbols only.
        if (marks === null) {
          marks = new Map();
          try { for (const p of await this.executor.getPositions()) if (p.currentPrice > 0) marks.set(p.symbol, p.currentPrice); } catch { /* fall through */ }
        }
        px = marks.get(s) ?? 0;
      }
      if (px > 0) out[s] = px;
    }
    return out;
  }

  /** Cancel the incumbent's resting protective stops on `symbols` (targeted, by exact order id,
   *  only orders stamped uc8- by getOpenStopOrders). Throws when the stop book cannot be read:
   *  unknown is never "no stops".
   *
   *  Alpaca's cancel is ASYNCHRONOUS: DELETE answers 204 while the order is still `pending_cancel`
   *  and its shares stay held, so a sell sent right after is rejected "insufficient qty available"
   *  (2026-10-23, 5 of 6 sells). Each accepted cancel is therefore polled (GET /orders/{id}) until
   *  the order is terminal, for at most `releaseConfirmTimeoutMs` (default 20 s) in total; the ones
   *  still not terminal are reported as `unconfirmed`. */
  async releaseLegacyStops(symbols: readonly string[]): Promise<LegacyStopRelease> {
    const out: LegacyStopRelease = { released: [], unconfirmed: [] };
    if (!this.executor.getOpenStopOrders || !this.executor.cancelOrderById) return out;
    const want = new Set(symbols);
    if (want.size === 0) return out;
    const accepted: Array<{ id: string; symbol: string }> = [];
    const failed: string[] = [];
    for (const stop of await this.executor.getOpenStopOrders()) {
      if (!want.has(stop.symbol) || stop.side !== "sell") continue;
      if (await this.executor.cancelOrderById(stop.id)) {
        accepted.push({ id: stop.id, symbol: stop.symbol });
        log.warn(`${stop.symbol}: incumbent stop ${stop.id} (${stop.clientOrderId}) cancel accepted — the row left the stop machinery`);
      } else {
        failed.push(`${stop.id} on ${stop.symbol}`);
      }
    }
    const now = this.opts.now ?? Date.now;
    const deadline = now() + (this.opts.releaseConfirmTimeoutMs ?? 20_000);
    const pollMs = this.opts.releasePollMs ?? 1_000;
    let pending = accepted;
    while (pending.length > 0) {
      const states = await Promise.all(pending.map(async (s) => ({ s, done: await this.isOrderTerminal(s.id) })));
      for (const { s, done } of states) if (done) out.released.push(s.id);
      pending = states.filter(x => !x.done).map(x => x.s);
      if (pending.length === 0 || now() >= deadline) break;
      await this.sleep(pollMs);
    }
    out.unconfirmed = pending.map(s => s.id);
    for (const s of pending) log.warn(`${s.symbol}: incumbent stop ${s.id} cancel NOT confirmed within the wait — its shares may still be held`);
    if (failed.length > 0) throw new Error(`could not cancel incumbent stop ${failed.join(", ")}`);
    return out;
  }

  /** True when the order is terminal at the venue (404 = gone). A failed read is "not yet". */
  private async isOrderTerminal(orderId: string): Promise<boolean> {
    try {
      const o = await this.client.getOrder(orderId);
      return ALPACA_TERMINAL_STATUSES.has(String(o?.status ?? ""));
    } catch (e: any) {
      const code = e?.response?.status || e?.status || null;
      if (code === 404) return true;
      log.debug(`confirm cancel ${orderId}: ${e?.message ?? e}`);
      return false;
    }
  }

  async submit(order: OrderIntent, clientOrderId: string): Promise<OrderResult> {
    if (order.side !== "buy") return this.submitOrder(order, clientOrderId);
    const previous = AlpacaVenue.buys.get(this.executor) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    AlpacaVenue.buys.set(this.executor, next);
    await previous;
    try { return await this.submitOrder(order, clientOrderId); }
    finally {
      release();
      if (AlpacaVenue.buys.get(this.executor) === next) AlpacaVenue.buys.delete(this.executor);
    }
  }

  private async submitOrder(order: OrderIntent, clientOrderId: string): Promise<OrderResult> {
    if (!this.executor.isConnected()) return { ok: false, filledQty: 0, avgPrice: null, status: "disconnected", error: "alpaca not connected" };
    if (!(order.qty > 0)) return { ok: false, filledQty: 0, avgPrice: null, status: "invalid", error: `non-positive qty ${order.qty}` };
    if (order.side === "buy" && this.executor.getAccount) {
      let headroom: number | null = null;
      try {
        const account = await this.executor.getAccount();
        const equity = parseFloat(String(account?.equity ?? ""));
        const gross = parseFloat(String(account?.long_market_value ?? ""));
        if (Number.isFinite(equity) && Number.isFinite(gross) && gross >= 0) {
          headroom = Math.max(0, ALPACA_ACCOUNT_MAX_GROSS * equity - gross);
        } else log.warn("account gross/equity unreadable — failing open");
      } catch (e: any) { log.warn(`account gross/equity unreadable (${e?.message ?? e}) — failing open`); }
      if (headroom !== null && order.notional > headroom) {
        // A retry may already have filled and consumed the headroom. Resolve that id BEFORE
        // clipping/blocking, or the engine could lose its fill after a crash. Unknown is not absent.
        try { return await this.awaitTerminal(await this.client.getOrderByClientId(clientOrderId), order); }
        catch (e: any) { if ((e?.response?.status || e?.status) !== 404) throw e; }
        const qty = Math.floor(order.qty * headroom / order.notional * 1e9) / 1e9;
        const notional = qty * order.notional / order.qty;
        log.warn(`BUY ${order.symbol} clipped by account gross cap ${ALPACA_ACCOUNT_MAX_GROSS}x: $${order.notional.toFixed(2)} → $${notional.toFixed(2)} (headroom $${headroom.toFixed(2)})`);
        if (!(qty > 0) || notional < (this.opts.minOrderNotional ?? 5)) {
          return { ok: false, filledQty: 0, avgPrice: null, status: "account_gross_cap", error: `account gross cap ${ALPACA_ACCOUNT_MAX_GROSS}x: remaining headroom $${headroom.toFixed(2)} below minimum order` };
        }
        order = { ...order, qty, notional };
      }
    }
    if (order.side === "buy" && this.executor.getRegTBuyingPower) {
      let bp: number | null = null;
      try { bp = await this.executor.getRegTBuyingPower(); } catch (e: any) { log.warn(`Reg-T buying power unreadable (${e?.message ?? e}) — failing open`); }
      if (bp !== null && order.notional > bp) {
        const error = `insufficient_buying_power (shared Alpaca account): need $${order.notional.toFixed(0)}, Reg-T buying power $${bp.toFixed(0)} — blocked pre-submit`;
        log.warn(`BUY ${order.symbol} blocked: ${error}`);
        return { ok: false, filledQty: 0, avgPrice: null, status: "insufficient_buying_power", error };
      }
    }
    let broker: any;
    try {
      broker = await this.client.createOrder({
        symbol: order.symbol,
        side: order.side,
        type: "market",
        time_in_force: "day",
        qty: formatFractionalQty(order.qty),
        client_order_id: clientOrderId,
      });
      log.info(`📤 ${order.side} ${formatFractionalQty(order.qty)} ${order.symbol} submitted (${clientOrderId}) → ${broker?.id}`);
    } catch (e: any) {
      const code = e?.response?.status || e?.status || null;
      const body = String(e?.response?.data?.message ?? e?.message ?? "");
      if (code === 422 && DUPLICATE_CLIENT_ORDER_ID_RE.test(body)) {
        log.warn(`${order.symbol}: duplicate client_order_id ${clientOrderId} — querying the existing order, not resending`);
        try {
          broker = await this.client.getOrderByClientId(clientOrderId);
        } catch (qe: any) {
          return { ok: false, filledQty: 0, avgPrice: null, status: "unknown", error: `duplicate ${clientOrderId} but lookup failed: ${qe?.message ?? qe}` };
        }
      } else if (code === null || code >= 500 || code === 429) {
        // Transmitted, fate unknown: resolve by client id; a 404 proves it never landed.
        try {
          broker = await this.client.getOrderByClientId(clientOrderId);
        } catch (qe: any) {
          const qcode = qe?.response?.status || qe?.status || null;
          if (qcode === 404) return { ok: false, filledQty: 0, avgPrice: null, status: "rejected", error: `submit failed (${body}); order absent from the books` };
          throw new Error(`submit ambiguous (${body}) and client_order_id lookup failed (${qe?.message ?? qe})`);
        }
      } else {
        return { ok: false, filledQty: 0, avgPrice: null, status: "rejected", error: `http_${code} ${body}` };
      }
    }
    return await this.awaitTerminal(broker, order);
  }

  private toResult(o: any, order: OrderIntent, note?: string): OrderResult {
    const filledQty = parseFloat(o?.filled_qty ?? "0") || 0;
    const avg = parseFloat(o?.filled_avg_price ?? "0") || 0;
    const status = String(o?.status ?? "unknown");
    const complete = filledQty >= order.qty * (1 - 1e-6);
    return {
      ok: status === "filled" || complete,
      filledQty,
      avgPrice: filledQty > 0 ? (avg > 0 ? avg : null) : null,
      status,
      brokerOrderId: o?.id ? String(o.id) : undefined,
      ...(note || (filledQty > 0 && !(avg > 0)) ? { error: note ?? "fill without filled_avg_price" } : {}),
    };
  }

  private async awaitTerminal(initial: any, order: OrderIntent): Promise<OrderResult> {
    const orderId = String(initial?.id ?? "");
    const timeoutMs = this.opts.fillTimeoutMs ?? 60_000;
    const pollMs = this.opts.pollIntervalMs ?? 2_000;
    const now = this.opts.now ?? Date.now;
    const start = now();
    let latest = initial;
    while (true) {
      const status = String(latest?.status ?? "");
      if (ALPACA_TERMINAL_STATUSES.has(status)) return this.toResult(latest, order);
      if (now() - start >= timeoutMs) break;
      await this.sleep(pollMs);
      if (!orderId) break;
      try { latest = await this.client.getOrder(orderId); } catch (e: any) { log.warn(`poll ${orderId}: ${e?.message ?? e}`); }
    }
    // Still working: cancel the REMAINDER by order id (never the position).
    if (orderId) {
      try { await this.client.cancelOrder(orderId); log.warn(`${order.symbol}: order ${orderId} timed out — remainder cancelled`); }
      catch (e: any) { log.warn(`${order.symbol}: cancel ${orderId} failed (${e?.message ?? e}) — reading final state`); }
      await this.sleep(this.opts.settleMs ?? 1_000);
      try { latest = await this.client.getOrder(orderId); } catch (e: any) { log.warn(`final read ${orderId}: ${e?.message ?? e}`); }
    }
    const status = String(latest?.status ?? "");
    const res = this.toResult(latest, order, ALPACA_TERMINAL_STATUSES.has(status) ? undefined : "order still working after timeout");
    return { ...res, ok: res.ok && ALPACA_TERMINAL_STATUSES.has(status) };
  }
}
