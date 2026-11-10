/**
 * Simulador de ejecución (paper) — el punto crítico: no puede mentir.
 *
 * Precio = curva de producto constante sobre las reservas virtuales REALES del
 * trade de referencia (el primer trade observado en t + latencia). Costes,
 * todos declarados en config.sim:
 *   - comisión de pump.fun: el MAYOR entre la observada en el trade de
 *     referencia (fee + creator_fee del TradeEvent) y el suelo configurado;
 *     en la compra se paga encima del SOL que entra en la curva, en la venta
 *     se descuenta del SOL que sale;
 *   - base fee + priority fee fija por transacción (SOL);
 *   - recargo MEV/sándwich por lado: la compra recibe (1 − mev) de los
 *     tokens, la venta entrega (1 − mev) del SOL.
 * Lo que NO modela (y por tanto sobreestima): el impacto de nuestra propia
 * orden sobre los trades ajenos posteriores, transacciones fallidas por
 * slippage, congestión de red, y el precio tras la migración (salida forzada
 * con recargo declarado).
 */
import { LAB_CONFIG, type LabConfig } from "./config";
import { buyTokensOut, LAMPORTS_PER_SOL, sellSolOut, TOKEN_DECIMALS, type CurveState } from "./curve";

export interface BuyFill {
  /** SOL total que sale de la caja (presupuesto + fee de tx). */
  solSpent: number;
  solToCurve: number;
  pumpFeeSol: number;
  mevSol: number;
  txFeeSol: number;
  feeBpsUsed: number;
  tokensRaw: number;
  /** Precio all-in en SOL por token entero. */
  priceSol: number;
}

export interface SellFill {
  /** SOL neto que entra en la caja (puede ser 0 si la posición no cubre ni los costes). */
  solReceived: number;
  solGross: number;
  pumpFeeSol: number;
  mevSol: number;
  txFeeSol: number;
  feeBpsUsed: number;
  tokensRaw: number;
  priceSol: number;
}

export function feeBpsFor(refFeeBps: number | null, cfg: LabConfig = LAB_CONFIG): number {
  return Math.max(refFeeBps ?? 0, cfg.sim.pumpFeeBpsFloor);
}

export function simulateBuy(curve: CurveState, budgetSol: number, refFeeBps: number | null, cfg: LabConfig = LAB_CONFIG): BuyFill {
  const bps = feeBpsFor(refFeeBps, cfg);
  const solToCurve = budgetSol / (1 + bps / 10_000);
  const pumpFeeSol = budgetSol - solToCurve;
  const rawOut = buyTokensOut(curve, Math.floor(solToCurve * LAMPORTS_PER_SOL));
  const tokensRaw = Math.floor(rawOut * (1 - cfg.sim.mevPerSide));
  const mevSol = solToCurve * cfg.sim.mevPerSide;
  const solSpent = budgetSol + cfg.sim.txFeeSol;
  const priceSol = tokensRaw > 0 ? solSpent / (tokensRaw / TOKEN_DECIMALS) : 0;
  return { solSpent, solToCurve, pumpFeeSol, mevSol, txFeeSol: cfg.sim.txFeeSol, feeBpsUsed: bps, tokensRaw, priceSol };
}

export function simulateSell(curve: CurveState, tokensRaw: number, refFeeBps: number | null, cfg: LabConfig = LAB_CONFIG, extraPenalty = 0): SellFill {
  const bps = feeBpsFor(refFeeBps, cfg);
  const grossLamports = sellSolOut(curve, tokensRaw);
  const solGross = (grossLamports / LAMPORTS_PER_SOL) * (1 - extraPenalty);
  const pumpFeeSol = solGross * (bps / 10_000);
  const mevSol = solGross * cfg.sim.mevPerSide;
  const net = solGross - pumpFeeSol - mevSol - cfg.sim.txFeeSol;
  const solReceived = net > 0 ? net : 0;
  const priceSol = tokensRaw > 0 ? solReceived / (tokensRaw / TOKEN_DECIMALS) : 0;
  return { solReceived, solGross, pumpFeeSol, mevSol, txFeeSol: cfg.sim.txFeeSol, feeBpsUsed: bps, tokensRaw, priceSol };
}

/** P&L ejecutable de una posición: lo que quedaría en caja vendiéndolo todo ahora, frente al coste total. */
export function executablePnlPct(curve: CurveState, tokensRaw: number, costSol: number, realizedSol: number, refFeeBps: number | null, cfg: LabConfig = LAB_CONFIG): number {
  if (costSol <= 0) return 0;
  const q = tokensRaw > 0 ? simulateSell(curve, tokensRaw, refFeeBps, cfg).solReceived : 0;
  return ((realizedSol + q - costSol) / costSol) * 100;
}
