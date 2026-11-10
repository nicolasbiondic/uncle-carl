/**
 * Estado por token en fase de curva: reconstrucción EXACTA de los saldos de
 * cada wallet a partir de los TradeEvent (compras suman, ventas restan),
 * reservas del último trade observado, flujo reciente y banderas (dev vendió,
 * migrado, hueco de datos).
 *
 * Un hueco en el feed invalida las métricas del token (`gapped = true`):
 * los saldos ya no son exactos y el token se descarta con motivo `data_gap`.
 * No se inventa nada.
 */
import type { CreateEvent, TradeEvent } from "./decoder";
import { spotPrice, type CurveState } from "./curve";
import { LAMPORTS_PER_SOL, TOKEN_DECIMALS } from "./curve";

export interface TrackedTrade {
  /** Instante de recepción local (ms). */
  at: number;
  user: string;
  isBuy: boolean;
  solLamports: number;
  tokenRaw: number;
  vSol: number;
  vTok: number;
  feeBps: number | null;
  signature: string;
}

export interface TokenMetrics {
  ageMs: number;
  tradesSeen: number;
  volumeSol: number;
  holders: number;
  /** Fracción de los tokens en circulación (fuera de la curva) en manos de los 10 mayores. */
  top10Share: number;
  /** Fracción en manos de wallets que compraron en los primeros `earlyWindowMs`. */
  earlyWalletsShare: number;
  earlyWallets: number;
  devSold: boolean;
  /** Ventana de entrada. */
  netBuySol: number;
  uniqueBuyers: number;
  buys: number;
  sells: number;
  buySellRatio: number;
  /** SOL neto en la ventana de reversión (para la salida). */
  reversalNetSol: number;
  priceSol: number;
  realSol: number;
  gapped: boolean;
  migrated: boolean;
}

export interface TrackerConfig {
  tradeHistoryMs: number;
  earlyWindowMs: number;
  entryWindowMs: number;
  reversalWindowMs: number;
  /** Topes por construcción (ver config.limits). */
  maxWallets: number;
  maxTrades: number;
}

export class TokenState {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly dev: string;
  readonly createdAt: number;
  readonly createdSlot: number;
  readonly initialVSol: number;
  readonly initialVTok: number;
  readonly initialRTok: number;
  readonly totalSupply: number;
  curve: CurveState;
  realSol = 0;
  lastTradeAt: number;
  tradesSeen = 0;
  volumeLamports = 0;
  devSold = false;
  migrated = false;
  migratedAt: number | null = null;
  gapped = false;
  /** Más wallets de las que cabe recordar: los saldos ya no son exactos (se trata como hueco). */
  overflow = false;
  peakPrice: number;
  /** Último fee observado en pb (null si el evento no lo trae). */
  lastFeeBps: number | null = null;
  readonly balances = new Map<string, number>();
  readonly earlyWallets = new Set<string>();
  private readonly trades: TrackedTrade[] = [];

  constructor(ev: CreateEvent, receivedAt: number, slot: number, private readonly cfg: TrackerConfig) {
    this.mint = ev.mint;
    this.name = ev.name;
    this.symbol = ev.symbol;
    this.dev = ev.creator;
    this.createdAt = receivedAt;
    this.createdSlot = slot;
    this.initialVSol = ev.vSol;
    this.initialVTok = ev.vTok;
    this.initialRTok = ev.rTok;
    this.totalSupply = ev.totalSupply;
    this.curve = { vSol: ev.vSol, vTok: ev.vTok };
    this.lastTradeAt = receivedAt;
    this.peakPrice = spotPrice(this.curve);
  }

  get price(): number {
    return spotPrice(this.curve);
  }

  onTrade(ev: TradeEvent, receivedAt: number, signature: string): void {
    this.tradesSeen++;
    this.volumeLamports += ev.solLamports;
    this.curve = { vSol: ev.vSol, vTok: ev.vTok };
    this.realSol = ev.rSol / LAMPORTS_PER_SOL;
    this.lastTradeAt = receivedAt;
    if (ev.feeBps !== null) this.lastFeeBps = ev.feeBps;
    const bal = this.balances.get(ev.user) ?? 0;
    const next = ev.isBuy ? bal + ev.tokenRaw : Math.max(0, bal - ev.tokenRaw);
    if (next > 0) {
      if (bal === 0 && this.balances.size >= this.cfg.maxWallets) {
        this.overflow = true;
        this.gapped = true;
      } else this.balances.set(ev.user, next);
    } else this.balances.delete(ev.user);
    if (ev.isBuy && receivedAt - this.createdAt <= this.cfg.earlyWindowMs && this.earlyWallets.size < this.cfg.maxWallets) this.earlyWallets.add(ev.user);
    if (!ev.isBuy && ev.user === this.dev && ev.tokenRaw > 0) this.devSold = true;
    const p = this.price;
    if (p > this.peakPrice) this.peakPrice = p;
    this.trades.push({ at: receivedAt, user: ev.user, isBuy: ev.isBuy, solLamports: ev.solLamports, tokenRaw: ev.tokenRaw, vSol: ev.vSol, vTok: ev.vTok, feeBps: ev.feeBps, signature });
    this.prune(receivedAt);
  }

  markMigrated(at: number): void {
    this.migrated = true;
    this.migratedAt = at;
  }

  markGap(): void {
    this.gapped = true;
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.tradeHistoryMs;
    while (this.trades.length > 0 && this.trades[0].at < cutoff) this.trades.shift();
    if (this.trades.length > this.cfg.maxTrades) this.trades.splice(0, this.trades.length - this.cfg.maxTrades);
  }

  /** Tamaños en memoria (para el soak test y el heartbeat). */
  sizes(): { balances: number; early: number; trades: number } {
    return { balances: this.balances.size, early: this.earlyWallets.size, trades: this.trades.length };
  }

  /** Trades recientes (copia de solo lectura). */
  recentTrades(): readonly TrackedTrade[] {
    return this.trades;
  }

  metrics(now: number): TokenMetrics {
    let held = 0;
    const sorted: number[] = [];
    for (const b of this.balances.values()) {
      held += b;
      sorted.push(b);
    }
    sorted.sort((a, b) => b - a);
    let top10 = 0;
    for (let i = 0; i < Math.min(10, sorted.length); i++) top10 += sorted[i];
    let early = 0;
    for (const w of this.earlyWallets) early += this.balances.get(w) ?? 0;

    const entryCut = now - this.cfg.entryWindowMs;
    const revCut = now - this.cfg.reversalWindowMs;
    let netBuy = 0;
    let buys = 0;
    let sells = 0;
    let rev = 0;
    const buyers = new Set<string>();
    for (const t of this.trades) {
      if (t.at >= entryCut) {
        if (t.isBuy) {
          netBuy += t.solLamports;
          buys++;
          buyers.add(t.user);
        } else {
          netBuy -= t.solLamports;
          sells++;
        }
      }
      if (t.at >= revCut) rev += t.isBuy ? t.solLamports : -t.solLamports;
    }
    return {
      ageMs: now - this.createdAt,
      tradesSeen: this.tradesSeen,
      volumeSol: this.volumeLamports / LAMPORTS_PER_SOL,
      holders: this.balances.size,
      top10Share: held > 0 ? top10 / held : 0,
      earlyWalletsShare: held > 0 ? early / held : 0,
      earlyWallets: this.earlyWallets.size,
      devSold: this.devSold,
      netBuySol: netBuy / LAMPORTS_PER_SOL,
      uniqueBuyers: buyers.size,
      buys,
      sells,
      buySellRatio: sells === 0 ? buys : buys / sells,
      reversalNetSol: rev / LAMPORTS_PER_SOL,
      priceSol: this.price,
      realSol: this.realSol,
      gapped: this.gapped,
      migrated: this.migrated,
    };
  }

  /** Tokens en circulación (fuera de la curva), en unidades enteras. */
  circulatingTokens(): number {
    let held = 0;
    for (const b of this.balances.values()) held += b;
    return held / TOKEN_DECIMALS;
  }
}
