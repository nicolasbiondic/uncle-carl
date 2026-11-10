/**
 * Cintas sintéticas y deterministas para los tests (sin red): generan
 * notificaciones decodificadas con reservas coherentes con la curva, y las
 * reproducen contra el lab llamando a `tick` cada segundo simulado.
 */
import { afterBuy, afterSell, buyTokensOut, LAMPORTS_PER_SOL, type CurveState } from "./curve";
import type { CompleteEvent, CreateEvent, Notification, TradeEvent } from "./decoder";
import type { MemecoinLab } from "./lab";

export interface TapeEntry {
  at: number;
  n: Notification;
}

/** PRNG determinista (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function fakeKey(r: () => number, suffix = ""): string {
  let s = "";
  for (let i = 0; i < 44 - suffix.length; i++) s += B58[Math.floor(r() * 58)];
  return s + suffix;
}

/** Reservas iniciales estándar de pump.fun (las que trae el CreateEvent real). */
export const STANDARD_CREATE = { vSol: 30 * LAMPORTS_PER_SOL, vTok: 1_073_000_000 * 1_000_000, rTok: 793_100_000 * 1_000_000, totalSupply: 1_000_000_000 * 1_000_000 };

export class TokenTape {
  readonly entries: TapeEntry[] = [];
  curve: CurveState;
  realSol = 0;
  realTok: number;
  private seq = 0;
  readonly dev: string;
  readonly mint: string;
  readonly wallets: string[] = [];

  constructor(readonly r: () => number, readonly t0: number, opts: { vSol?: number; symbol?: string; mint?: string } = {}) {
    this.mint = opts.mint ?? fakeKey(r, "pump");
    this.dev = fakeKey(r);
    this.curve = { vSol: opts.vSol ?? STANDARD_CREATE.vSol, vTok: STANDARD_CREATE.vTok };
    this.realTok = STANDARD_CREATE.rTok;
    const ev: CreateEvent = {
      type: "create",
      name: opts.symbol ?? "TEST",
      symbol: opts.symbol ?? "TEST",
      uri: "https://example.invalid/meta.json",
      mint: this.mint,
      bondingCurve: fakeKey(r),
      user: this.dev,
      creator: this.dev,
      timestamp: Math.floor(t0 / 1000),
      vTok: this.curve.vTok,
      vSol: this.curve.vSol,
      rTok: this.realTok,
      totalSupply: STANDARD_CREATE.totalSupply,
    };
    this.push(t0, ev);
  }

  private push(at: number, ev: TradeEvent | CreateEvent | CompleteEvent): void {
    this.seq++;
    this.entries.push({ at, n: { kind: "notification", slot: 1_000_000 + Math.floor((at - this.t0) / 400), signature: `${this.mint.slice(0, 8)}-${this.seq}`, events: [ev] } });
  }

  wallet(i: number): string {
    while (this.wallets.length <= i) this.wallets.push(fakeKey(this.r));
    return this.wallets[i];
  }

  buy(at: number, user: string, sol: number, feeBps: number | null = 125): TradeEvent {
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    const out = buyTokensOut(this.curve, lamports);
    this.curve = afterBuy(this.curve, lamports);
    this.realSol += lamports;
    this.realTok -= out;
    const ev: TradeEvent = { type: "trade", mint: this.mint, solLamports: lamports, tokenRaw: out, isBuy: true, user, timestamp: Math.floor(at / 1000), vSol: this.curve.vSol, vTok: this.curve.vTok, rSol: this.realSol, rTok: this.realTok, feeBps, feeLamports: feeBps === null ? null : Math.floor((lamports * feeBps) / 10_000) };
    this.push(at, ev);
    return ev;
  }

  sell(at: number, user: string, tokensRaw: number, feeBps: number | null = 125): TradeEvent {
    const before = this.curve;
    this.curve = afterSell(this.curve, tokensRaw);
    const solOut = before.vSol - this.curve.vSol;
    this.realSol -= solOut;
    this.realTok += tokensRaw;
    const ev: TradeEvent = { type: "trade", mint: this.mint, solLamports: solOut, tokenRaw: tokensRaw, isBuy: false, user, timestamp: Math.floor(at / 1000), vSol: this.curve.vSol, vTok: this.curve.vTok, rSol: this.realSol, rTok: this.realTok, feeBps, feeLamports: feeBps === null ? null : Math.floor((solOut * feeBps) / 10_000) };
    this.push(at, ev);
    return ev;
  }

  complete(at: number): void {
    this.push(at, { type: "complete", user: this.dev, mint: this.mint, bondingCurve: "curve", timestamp: Math.floor(at / 1000) });
  }
}

/**
 * Escenario FOMO sano: compras de muchas wallets distintas durante `minutes`
 * minutos, sin ventas. El tamaño crece con `growth` a lo largo de la cinta
 * (los últimos pagan más SOL por los mismos tokens, como en un FOMO real);
 * sin eso los primeros compradores concentran siempre > 20 % del top 10.
 */
export function fomoTape(seed: number, t0: number, opts: { buyers?: number; minutes?: number; solPerBuy?: number; symbol?: string; growth?: number } = {}): TokenTape {
  const r = rng(seed);
  const tape = new TokenTape(r, t0, { symbol: opts.symbol ?? "FOMO" });
  const buyers = opts.buyers ?? 90;
  const minutes = opts.minutes ?? 4;
  const growth = opts.growth ?? 2.5;
  const step = (minutes * 60_000) / buyers;
  // El dev compra algo al crear (initial buy) para que haya un holder desde t0.
  tape.buy(t0 + 200, tape.dev, 0.3);
  for (let i = 0; i < buyers; i++) tape.buy(t0 + 2_500 + Math.floor(i * step), tape.wallet(i), (opts.solPerBuy ?? 0.25) * (1 + (growth * i) / buyers) * (0.8 + r() * 0.4));
  return tape;
}

/** Pump & dump: FOMO hasta `dumpAtMs` y entonces el dev y los primeros compradores vuelcan todo (cronológico). */
export function pumpAndDumpTape(seed: number, t0: number, dumpAtMs = 180_000): TokenTape {
  const r = rng(seed);
  const tape = new TokenTape(r, t0, { symbol: "DUMP" });
  const buyers = 90;
  const step = (4 * 60_000) / buyers;
  const holders = new Map<string, number>();
  const devBuy = tape.buy(t0 + 200, tape.dev, 0.3);
  holders.set(tape.dev, devBuy.tokenRaw);
  let i = 0;
  for (; i < buyers; i++) {
    const at = t0 + 2_500 + Math.floor(i * step);
    if (at >= t0 + dumpAtMs) break;
    const ev = tape.buy(at, tape.wallet(i), 0.25 * (1 + (2.5 * i) / buyers) * (0.8 + r() * 0.4));
    holders.set(ev.user, (holders.get(ev.user) ?? 0) + ev.tokenRaw);
  }
  let t = t0 + dumpAtMs;
  tape.sell(t, tape.dev, holders.get(tape.dev)!);
  for (let j = 0; j < 12 && j < i; j++) {
    t += 400;
    const w = tape.wallet(j);
    tape.sell(t, w, holders.get(w) ?? 0);
  }
  return tape;
}

/** Reproduce una o varias cintas contra el lab, llamando a tick cada segundo simulado hasta `untilMs`. */
export function playTapes(lab: MemecoinLab, tapes: TokenTape[], untilMs: number, tickMs = 1_000): void {
  const all = tapes.flatMap((t) => t.entries).sort((a, b) => a.at - b.at);
  let nextTick = all.length > 0 ? all[0].at : untilMs;
  for (const e of all) {
    while (nextTick <= e.at) {
      lab.tick(nextTick);
      nextTick += tickMs;
    }
    lab.onNotification(e.n, e.at);
  }
  while (nextTick <= untilMs) {
    lab.tick(nextTick);
    nextTick += tickMs;
  }
}
