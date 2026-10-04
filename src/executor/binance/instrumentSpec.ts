// ══════════════════════════════════════════════
// Binance USDⓈ-M instrument specs from /fapi/v1/exchangeInfo (2026-07-19)
//
// Replaces the old hardcoded QTY_PRECISION/PRICE_PRECISION tables. Precision
// drifts per-symbol over time (e.g. AVAXUSDT's LOT_SIZE stepSize has moved
// to whole units on testnet — the old hardcoded 0.1 would now floor every
// order to the wrong step and get rejected). The catalog is a plain
// injectable/seedable class so tests never hit the network.
// ══════════════════════════════════════════════

export interface InstrumentSpec {
  symbol: string;
  status: string;
  contractType: string;
  marginAsset: string;
  tickSize: number;
  minPrice: number;
  maxPrice: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  marketStepSize: number;
  marketMinQty: number;
  marketMaxQty: number;
  /** Futures MIN_NOTIONAL filter's `notional` field. null when the filter is absent. */
  minNotional: number | null;
}

/** Decimal places of a step/tick value ("0.00100000" -> 3, "1.00000000" -> 0). */
export function decimalPlaces(numStr: string): number {
  const n = parseFloat(numStr);
  if (!Number.isFinite(n) || n === 0 || Number.isInteger(n)) return 0;
  const s = n.toString();
  const eIdx = s.indexOf("e-");
  if (eIdx !== -1) return parseInt(s.slice(eIdx + 2), 10);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Floor `value` to the nearest multiple of `step` (never rounds up — a
 *  floored qty must stay affordable/within the position being closed). */
export function floorToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const decimals = decimalPlaces(step.toString());
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(decimals));
}

function num(v: any, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Contract types this repo ever executes on (perpetual USDⓈ-M futures). */
const ALLOWED_CONTRACT_TYPES = new Set(["PERPETUAL"]);

/**
 * Parse one `exchangeInfo.symbols[]` entry. Returns null for malformed rows
 * AND for rows that are structurally fine but unsafe to trade: not TRADING,
 * not a perpetual, no margin asset, or any filter the executor depends on
 * (PRICE_FILTER tick, LOT_SIZE/MARKET_LOT_SIZE step+min+max, MIN_NOTIONAL
 * when present) missing/non-positive. A rejected spec is NOT a guess at a
 * fallback precision — callers (BinanceExecutor.resolveQtyStep) fail closed
 * for a NEW entry and fail open only in the safe direction for a close
 * (preserve the exact broker-reported quantity instead of rounding it).
 */
export function parseInstrumentSpec(raw: any): InstrumentSpec | null {
  if (!raw || typeof raw.symbol !== "string") return null;
  // USDⓈ-M's /fapi/v1/exchangeInfo names this field `status`; COIN-M's
  // /dapi/v1/exchangeInfo names the SAME semantic field `contractStatus` —
  // a genuine, verified API-schema divergence between Binance's two futures
  // products (confirmed against ccxt's real captured COIN-M row). Falling
  // back to `contractStatus` costs nothing for USDⓈ-M rows (never present
  // there) and lets this catalog be safely reused for COIN-M in the future.
  const status = String(raw.status ?? raw.contractStatus ?? "");
  if (status !== "TRADING") return null;
  const contractType = String(raw.contractType ?? "");
  if (!ALLOWED_CONTRACT_TYPES.has(contractType)) return null;
  const marginAsset = String(raw.marginAsset ?? "");
  if (!marginAsset) return null;

  const filters: any[] = Array.isArray(raw.filters) ? raw.filters : [];
  const find = (t: string) => filters.find((f) => f?.filterType === t);
  const priceF = find("PRICE_FILTER");
  const lotF = find("LOT_SIZE");
  const marketLotF = find("MARKET_LOT_SIZE") ?? lotF;
  const notionalF = find("MIN_NOTIONAL");

  const tickSize = num(priceF?.tickSize);
  if (!(tickSize > 0)) return null;
  const stepSize = num(lotF?.stepSize);
  const minQty = num(lotF?.minQty);
  const maxQty = num(lotF?.maxQty);
  if (!(stepSize > 0) || !(minQty > 0) || !(maxQty > 0)) return null;
  const marketStepSize = num(marketLotF?.stepSize);
  const marketMinQty = num(marketLotF?.minQty);
  const marketMaxQty = num(marketLotF?.maxQty);
  if (!(marketStepSize > 0) || !(marketMinQty > 0) || !(marketMaxQty > 0)) return null;

  // A MIN_NOTIONAL filter that's present but unparseable/non-positive is
  // worse than absent — silently defaulting it to 0 (old behavior) would
  // let every order through the very gate it exists to enforce.
  let minNotional: number | null = null;
  if (notionalF) {
    const n = num(notionalF.notional, NaN);
    if (!(n > 0)) return null;
    minNotional = n;
  }

  return {
    symbol: raw.symbol,
    status,
    contractType,
    marginAsset,
    tickSize,
    minPrice: num(priceF?.minPrice),
    maxPrice: num(priceF?.maxPrice),
    stepSize,
    minQty,
    maxQty,
    marketStepSize,
    marketMinQty,
    marketMaxQty,
    minNotional,
  };
}

/**
 * Cached, injectable catalog. `ensure()` fetches lazily (once) the first time
 * an unknown symbol is requested; `seed()` lets tests bypass the network
 * entirely. A failed fetch throws (callers decide the fallback) and leaves
 * whatever was already cached untouched.
 */
export class InstrumentCatalog {
  private specs = new Map<string, InstrumentSpec>();

  constructor(private fetchExchangeInfo: () => Promise<any>) {}

  seed(specs: InstrumentSpec[]): void {
    for (const s of specs) this.specs.set(s.symbol, s);
  }

  get(symbol: string): InstrumentSpec | undefined {
    return this.specs.get(symbol);
  }

  async ensure(symbol: string): Promise<InstrumentSpec | undefined> {
    if (this.specs.has(symbol)) return this.specs.get(symbol);
    await this.refresh();
    return this.specs.get(symbol);
  }

  async refresh(): Promise<void> {
    const data = await this.fetchExchangeInfo();
    const list = Array.isArray(data?.symbols) ? data.symbols : [];
    for (const raw of list) {
      const spec = parseInstrumentSpec(raw);
      if (spec) this.specs.set(spec.symbol, spec);
    }
  }
}
