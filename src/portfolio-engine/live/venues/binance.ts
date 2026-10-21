import { createHash } from "crypto";
import { SYMBOL_MAP } from "../../../executor/binance-executor";
import { USDC_SYMBOL_MAP } from "../../../executor/binance/quoteAsset";
import { InstrumentCatalog, floorToStep, type InstrumentSpec } from "../../../executor/binance/instrumentSpec";
import type { BinanceUsdmTransport } from "../../../executor/binance/usdmTransport";
import { symbolLocks } from "../../../executor/symbolLock";
import type { OrderIntent, OrderResult, Position, StopLevel, VenueAdapter, VenueRules } from "../../types";

export interface BinanceVenueOptions {
  venue: "binance_usdm" | "binance_usdc";
  sleeveId: string;
  /** Exclusive native-symbol ownership within this account; use canonical XXX/USD
   * symbols for BOTH quotes (legacy XXX/USDC is also accepted for USDC). */
  symbols: readonly string[];
  /** Already configured for the paper endpoint. Owns signing, timeouts, shared
   * rate limits and normalized errors; this adapter never reads env/credentials. */
  transport: BinanceUsdmTransport;
  /** Atomically persist the id BEFORE returning true, false if already claimed.
   * Must survive restarts, never expire ids, and be shared by concurrent runners.
   * Binance only enforces uniqueness among OPEN orders: querying alone cannot
   * prevent duplicate fills after a timeout, restart or history retention expiry.
   * A claim is NEVER released, even on rejection: a new attempt needs a new id. */
  claimOrderId(id: string): Promise<boolean>;
}

interface NativeStop {
  algo: boolean;
  id: string;
  clientId: string;
  qty: number;
  price: number;
  side: string;
  type: string;
  reduceOnly: boolean;
  workingType: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const failure = (status: string, error: string): OrderResult => ({ ok: false, filledQty: 0, avgPrice: null, status, error });
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const code = (e: unknown) => (e as { code?: number })?.code;

/** Long-only, one-way USDⓈ-M perpetuals. Assumes preconfigured leverage and
 * margin (single-asset USDT/USDC wallets), and exclusive sleeve ownership of
 * each native symbol. NO leverage/margin/position-mode setters are called.
 * Hedge mode and unexpected shorts fail closed, never silently look flat.
 * Not wired to any running engine: caller supplies a paper-only transport and
 * durable claimOrderId implementation before enabling writes.
 */
export class BinanceVenueAdapter implements VenueAdapter {
  readonly venue: "binance_usdm" | "binance_usdc";
  private readonly symbols: readonly string[];
  private readonly native = new Map<string, string>();
  private readonly catalog: InstrumentCatalog;
  private readonly scope: string;
  private readonly stopPrefix: string;
  private modeCheck?: Promise<void>;

  constructor(private readonly options: BinanceVenueOptions) {
    this.venue = options.venue;
    if (!options.sleeveId.trim()) throw new Error("Binance venue requires a sleeveId");
    this.scope = hash(`${this.venue}:${options.sleeveId}`).slice(0, 12);
    // Not uc-: the old executor's broad isBotFapiClientId must not own these.
    this.stopPrefix = `pe-s-${this.scope}-`;
    const seen = new Set<string>();
    for (const symbol of options.symbols) {
      const native = this.venue === "binance_usdc"
        ? USDC_SYMBOL_MAP[symbol.replace(/\/USD$/, "/USDC")]
        : SYMBOL_MAP[symbol];
      if (!native) throw new Error(`No ${this.venue} mapping for ${symbol}`);
      if (seen.has(native)) throw new Error(`Duplicate native symbol ${native}`);
      seen.add(native);
      this.native.set(symbol, native);
    }
    this.symbols = [...options.symbols];
    this.catalog = new InstrumentCatalog(async () => this.publicJson("/fapi/v1/exchangeInfo"));
  }

  private toNative(symbol: string): string {
    const native = this.native.get(symbol);
    if (!native) throw new Error(`Symbol outside sleeve: ${symbol}`);
    return native;
  }

  private lockSymbol(symbol: string): string {
    return this.venue === "binance_usdc" ? symbol.replace(/\/USD$/, "/USDC") : symbol;
  }

  private async publicJson(path: string, params: Record<string, string> = {}): Promise<any> {
    const res = await this.options.transport.publicRequest(path, params, "background");
    if (!res.ok) throw new Error(`Binance ${path} HTTP ${res.status}`);
    return res.json();
  }

  private async oneWay(): Promise<void> {
    this.modeCheck ??= this.options.transport.signedRequest("GET", "/fapi/v1/positionSide/dual", {}, "trade")
      .then(raw => {
        if (raw?.dualSidePosition !== false && raw?.dualSidePosition !== "false") {
          throw new Error("Binance venue requires one-way position mode (not changed automatically)");
        }
      }).catch(e => { this.modeCheck = undefined; throw e; });
    await this.modeCheck;
  }

  private async spec(symbol: string): Promise<InstrumentSpec> {
    const native = this.toNative(symbol);
    const spec = await this.catalog.ensure(native);
    const margin = this.venue === "binance_usdc" ? "USDC" : "USDT";
    if (!spec || spec.marginAsset !== margin) throw new Error(`Missing valid ${margin} perpetual filters for ${native}`);
    return spec;
  }

  async rules(symbols: readonly string[]): Promise<VenueRules> {
    const qtyStep: Record<string, number> = {}, minNotional: Record<string, number> = {};
    for (const symbol of symbols) {
      const spec = await this.spec(symbol);
      qtyStep[symbol] = spec.marketStepSize;
      minNotional[symbol] = Math.max(5, spec.minNotional ?? 0);
    }
    return { venue: this.venue, fractional: false, minOrderNotional: 5, rebalanceBand: 0.02, qtyStep, minNotional };
  }

  async positions(symbols: readonly string[]): Promise<Position[]> {
    const requested = new Map(symbols.map(s => [this.toNative(s), s]));
    if (!requested.size) return [];
    await this.oneWay();
    const raw = await this.options.transport.signedRequest("GET", "/fapi/v2/positionRisk",
      requested.size === 1 ? { symbol: [...requested.keys()][0] } : {}, "protect");
    if (!Array.isArray(raw)) throw new Error("Invalid Binance positionRisk response");
    const result: Position[] = [];
    for (const row of raw) {
      const symbol = requested.get(row.symbol);
      if (!symbol) continue;
      const qty = Number(row.positionAmt), avgEntryPrice = Number(row.entryPrice);
      if ((row.positionSide !== undefined && row.positionSide !== "BOTH") || !Number.isFinite(qty) || qty < 0) {
        throw new Error(`Unexpected short/hedge/invalid position for ${symbol}`);
      }
      if (!qty) continue;
      if (!(avgEntryPrice > 0) || !Number.isFinite(avgEntryPrice)) throw new Error(`Invalid entry price for ${symbol}`);
      result.push({ symbol, qty, avgEntryPrice });
    }
    return result;
  }

  async prices(symbols: readonly string[]): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const symbol of symbols) {
      const raw = await this.publicJson("/fapi/v1/premiumIndex", { symbol: this.toNative(symbol) });
      const price = Number(raw?.markPrice);
      if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid mark price for ${symbol}`);
      prices[symbol] = price;
    }
    return prices;
  }

  private clientId(id: string): string {
    if (!id) throw new Error("Empty clientOrderId");
    return `pe-o-${hash(`${this.scope}:${id}`).slice(0, 31)}`; // 36 safe ASCII chars
  }

  private async query(symbol: string, id: string): Promise<any | null> {
    try {
      const raw = await this.options.transport.signedRequest("GET", "/fapi/v1/order", { symbol, origClientOrderId: id }, "trade");
      if (!raw?.orderId) throw new Error("Invalid Binance order query response");
      return raw;
    } catch (e) {
      if (code(e) === -2013) return null;
      throw e; // read failure is NOT proof of absence
    }
  }

  private async orderResult(raw: any, native: string, id: string): Promise<OrderResult> {
    // SDK MARKET POST returns ACK; query the actual per-order fills, NEVER
    // infer quantity from the aggregate position or price from a mark.
    for (let i = 0; i < 3 && ["NEW", "PARTIALLY_FILLED", ""].includes(String(raw?.status ?? "")); i++) {
      if (i > 0) await Bun.sleep(100);
      try { raw = await this.query(native, id) ?? raw; } catch { break; }
    }
    const qty = Number(raw?.executedQty ?? 0);
    const avg = Number(raw?.avgPrice) || (qty > 0 ? Number(raw?.cumQuote) / qty : 0);
    const filledQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
    const avgPrice = Number.isFinite(avg) && avg > 0 ? avg : null;
    return { ok: filledQty > 0 && avgPrice !== null, filledQty, avgPrice,
      status: String(raw?.status ?? "UNKNOWN"), brokerOrderId: raw?.orderId === undefined ? undefined : String(raw.orderId) };
  }

  async submit(order: OrderIntent, clientOrderId: string): Promise<OrderResult> {
    try {
      this.toNative(order.symbol);
      return await symbolLocks.withLock("binance_fapi", this.lockSymbol(order.symbol), { label: "portfolio.submit" },
        () => this.submitLocked(order, clientOrderId), () => failure("NOT_SUBMITTED", "Symbol lock timeout"));
    } catch (e) { return failure("ERROR", errorText(e)); }
  }

  private async submitLocked(order: OrderIntent, clientOrderId: string): Promise<OrderResult> {
    const native = this.toNative(order.symbol), id = this.clientId(clientOrderId);
    // Query even when today's filters/notional/position have changed: a retry
    // must report the ORIGINAL fill, not skip it or submit another order.
    const existing = await this.query(native, id);
    if (existing) return this.orderResult(existing, native, id);
    if (!(order.qty > 0) || !Number.isFinite(order.qty) || order.reduceOnly !== (order.side === "sell")) {
      return failure("INVALID", "Long-only requires buys to increase and sells to be reduceOnly");
    }
    await this.oneWay();
    const spec = await this.spec(order.symbol);
    const held = (await this.positions([order.symbol]))[0]?.qty ?? 0;
    const qty = floorToStep(order.reduceOnly ? Math.min(order.qty, held) : order.qty, spec.marketStepSize);
    if (!(qty >= spec.marketMinQty) || qty > spec.marketMaxQty) return failure("SKIPPED", "Quantity outside MARKET_LOT_SIZE");
    // Reductions are exempt from Binance's minimum notional: do not strand dust.
    if (!order.reduceOnly) {
      const price = (await this.prices([order.symbol]))[order.symbol];
      if (qty * price < Math.max(5, spec.minNotional ?? 0)) return failure("SKIPPED", "Below minimum notional after rounding");
    }
    if (!await this.options.claimOrderId(id)) return failure("UNKNOWN", "Id already consumed; query only, never resend");
    try {
      const raw = await this.options.transport.signedRequest("POST", "/fapi/v1/order", {
        symbol: native, side: order.side.toUpperCase(), type: "MARKET", quantity: String(qty),
        ...(order.reduceOnly ? { reduceOnly: "true" } : {}), newClientOrderId: id,
      }, order.reduceOnly ? "protect" : "trade");
      return this.orderResult(raw, native, id);
    } catch (e) {
      // Includes duplicate client id (-4116/-2010), disconnects and 5xx.
      // No POST retry, not even when the query says -2013 (eventual visibility).
      try {
        const found = await this.query(native, id);
        if (found) return this.orderResult(found, native, id);
      } catch { /* preserve original error; a durable claim prevents resend */ }
      return failure("UNKNOWN", errorText(e));
    }
  }

  private async openStops(native: string): Promise<NativeStop[]> {
    const transport = this.options.transport;
    const regular = await transport.signedRequest("GET", "/fapi/v1/openOrders", { symbol: native }, "protect");
    const algoRaw = await transport.signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: native }, "protect");
    const algo = Array.isArray(algoRaw) ? algoRaw : algoRaw?.orders;
    if (!Array.isArray(regular) || !Array.isArray(algo)) throw new Error("Invalid Binance open stop response");
    return [
      ...regular.map((o: any) => ({ o, algo: false })), ...algo.map((o: any) => ({ o, algo: true })),
    ].filter(({ o, algo }) => o.symbol === native && String(algo ? o.clientAlgoId : o.clientOrderId).startsWith(this.stopPrefix))
      .map(({ o, algo }) => ({ algo, id: String(algo ? o.algoId : o.orderId),
        clientId: String(algo ? o.clientAlgoId : o.clientOrderId),
        qty: Number(o.totalQty ?? o.origQty ?? o.quantity ?? o.qty),
        price: Number(o.triggerPrice ?? o.stopPrice), side: String(o.side),
        type: String(o.orderType ?? o.type ?? o.actualOrderType),
        reduceOnly: o.reduceOnly === true || o.reduceOnly === "true", workingType: String(o.workingType),
      }));
  }

  private async createStop(native: string, qty: number, price: number): Promise<void> {
    // Same normalized protection → same OPEN-order id, including after a lost
    // POST response while openOrders is still lagging. A fired/canceled stop's
    // id may be reused to protect a later position (Binance's open-only scope).
    const id = `${this.stopPrefix}${hash(`${native}:${qty}:${price}`).slice(0, 36 - this.stopPrefix.length)}`;
    const common = { symbol: native, side: "SELL", type: "STOP_MARKET", quantity: String(qty), reduceOnly: "true", workingType: "MARK_PRICE" };
    try {
      let result: any;
      try {
        result = await this.options.transport.signedRequest("POST", "/fapi/v1/order", { ...common, stopPrice: String(price), newClientOrderId: id }, "protect");
      } catch (e) {
        if (code(e) !== -4120) throw e;
        result = await this.options.transport.signedRequest("POST", "/fapi/v1/algoOrder", {
          ...common, algoType: "CONDITIONAL", triggerPrice: String(price), clientAlgoId: id,
        }, "protect");
      }
      if (!result?.orderId && !result?.algoId) throw new Error("Stop creation not acknowledged");
    } catch (e) {
      if (!(await this.openStops(native)).some(s => s.clientId === id)) throw e;
    }
  }

  async syncStops(stops: readonly StopLevel[], positions: readonly Position[]): Promise<void> {
    const desired = new Map<string, number>();
    for (const stop of stops) {
      this.toNative(stop.symbol);
      if (!(stop.stopPrice > 0) || !Number.isFinite(stop.stopPrice) || desired.has(stop.symbol)) throw new Error("Invalid/duplicate stop level");
      desired.set(stop.symbol, stop.stopPrice);
    }
    for (const position of positions) this.toNative(position.symbol);
    await this.oneWay();
    // Enumerate the configured universe, not just the two inputs: []/[] must
    // remove stale owned stops when flat or when switching to the no-stop design.
    for (const symbol of this.symbols) {
      await symbolLocks.withLock("binance_fapi", this.lockSymbol(symbol), { label: "portfolio.syncStops" }, async () => {
        const native = this.toNative(symbol);
        const open = await this.openStops(native); // both stores must be readable before ANY mutation
        const live = (await this.positions([symbol]))[0]; // supplied snapshot may be stale
        const level = desired.get(symbol);
        let keep: NativeStop | undefined;
        if (live && level !== undefined) {
          const spec = await this.spec(symbol);
          const qty = floorToStep(live.qty, spec.marketStepSize), price = floorToStep(level, spec.tickSize);
          if (!(qty > 0) || !(price > 0)) throw new Error(`Unrepresentable stop for ${symbol}`);
          keep = open.find(s => s.qty === qty && s.price === price && s.side === "SELL" &&
            ["STOP_MARKET", "STOP"].includes(s.type) && s.reduceOnly && s.workingType === "MARK_PRICE");
          // Install first: failed replacement leaves the existing protection intact.
          if (!keep) await this.createStop(native, qty, price);
        }
        for (const old of open) {
          if (old === keep) continue;
          await this.options.transport.signedRequest("DELETE", old.algo ? "/fapi/v1/algoOrder" : "/fapi/v1/order",
            { symbol: native, [old.algo ? "algoId" : "orderId"]: old.id }, "protect");
        }
      }, () => { throw new Error(`Stop sync symbol lock timeout: ${symbol}`); });
    }
  }
}
