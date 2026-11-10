/**
 * Curva de producto constante de pump.fun sobre reservas VIRTUALES.
 *
 * Unidades crudas (lamports y unidades de token con 6 decimales), igual que
 * el programa: así la aritmética reproduce lo que se liquida on-chain.
 * Las reservas caben en `number` sin pérdida (≤ 2^53).
 *
 * Compra: el usuario entrega `solIn` a la curva (la comisión se cobra APARTE,
 * encima) y recibe  tokens = vTok − k / (vSol + solIn).
 * Venta: entrega `tokIn` y recibe  sol = vSol − k / (vTok + tokIn), de donde
 * se descuenta la comisión.
 */

export interface CurveState {
  /** Reservas virtuales de SOL (lamports). */
  vSol: number;
  /** Reservas virtuales de token (unidades crudas, 6 decimales). */
  vTok: number;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 1_000_000;

/** Precio marginal en SOL por token entero. */
export function spotPrice(c: CurveState): number {
  if (c.vTok <= 0) return 0;
  return (c.vSol / LAMPORTS_PER_SOL) / (c.vTok / TOKEN_DECIMALS);
}

/** Tokens crudos recibidos por `solInLamports` (sin comisión). */
export function buyTokensOut(c: CurveState, solInLamports: number): number {
  if (solInLamports <= 0 || c.vSol <= 0 || c.vTok <= 0) return 0;
  const k = c.vSol * c.vTok;
  return Math.floor(c.vTok - k / (c.vSol + solInLamports));
}

/** Lamports recibidos por `tokInRaw` (antes de comisión). */
export function sellSolOut(c: CurveState, tokInRaw: number): number {
  if (tokInRaw <= 0 || c.vSol <= 0 || c.vTok <= 0) return 0;
  const k = c.vSol * c.vTok;
  return Math.floor(c.vSol - k / (c.vTok + tokInRaw));
}

/** Estado tras una compra de `solInLamports` (para encadenar). */
export function afterBuy(c: CurveState, solInLamports: number): CurveState {
  const out = buyTokensOut(c, solInLamports);
  return { vSol: c.vSol + solInLamports, vTok: c.vTok - out };
}

/** Estado tras una venta de `tokInRaw`. */
export function afterSell(c: CurveState, tokInRaw: number): CurveState {
  const out = sellSolOut(c, tokInRaw);
  return { vSol: c.vSol - out, vTok: c.vTok + tokInRaw };
}
