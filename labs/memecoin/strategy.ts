/**
 * Estrategia v1 "FOMO-momentum", pre-registrada en config.ts. Funciones
 * puras: métricas → veredicto. Toda cifra viene de LAB_CONFIG.
 *
 * Score 0–1 (transparente): media ponderada de cuatro componentes, cada uno
 * recortado a [0, 1]:
 *   netBuy     = netBuySol / (2·A)            (cumplir A justo = 0,5; doble = 1)
 *   buyers     = uniqueBuyers / (2·N)
 *   ratio      = (buySellRatio − 1) / (2·(R − 1))
 *   dispersion = 1 − top10Share / top10MaxShare (0 en el límite del filtro, 1 si nadie concentra)
 * Entrada = todos los filtros y umbrales cumplidos Y score ≥ scoreThreshold.
 */
import { LAB_CONFIG, type LabConfig } from "./config";
import type { TokenMetrics } from "./tracker";

export type DiscardReason =
  | "too_young"
  | "too_old"
  | "inactive"
  | "data_gap"
  | "migrated"
  | "near_graduation"
  | "curve_atypical"
  | "top10_concentrated"
  | "early_wallets"
  | "dev_sold"
  | "low_volume"
  | "few_holders"
  | "low_net_buy"
  | "few_buyers"
  | "low_buy_sell_ratio"
  | "low_score"
  | "max_positions"
  | "insufficient_balance"
  | "already_traded"
  | "already_open";

export interface ScoreBreakdown {
  netBuy: number;
  buyers: number;
  ratio: number;
  dispersion: number;
  score: number;
}

export interface Verdict {
  enter: boolean;
  reason: DiscardReason | "enter";
  score: ScoreBreakdown;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Orden de la cadena de filtros: a mayor índice, más cerca estuvo el token de entrar (desempate del "mejor momento"). */
export const REASON_ORDER: readonly (DiscardReason | "enter")[] = [
  "too_young",
  "too_old",
  "inactive",
  "data_gap",
  "migrated",
  "curve_atypical",
  "top10_concentrated",
  "early_wallets",
  "dev_sold",
  "low_volume",
  "few_holders",
  "near_graduation",
  "low_net_buy",
  "few_buyers",
  "low_buy_sell_ratio",
  "low_score",
  "max_positions",
  "insufficient_balance",
  "already_traded",
  "already_open",
  "enter",
];
export const reasonRank = (r: DiscardReason | "enter"): number => REASON_ORDER.indexOf(r);

export function scoreCandidate(m: TokenMetrics, cfg: LabConfig = LAB_CONFIG): ScoreBreakdown {
  const e = cfg.strategy.entry;
  const netBuy = clamp01(m.netBuySol / (2 * e.netBuySolMin));
  const buyers = clamp01(m.uniqueBuyers / (2 * e.uniqueBuyersMin));
  const ratio = clamp01((m.buySellRatio - 1) / (2 * (e.buySellRatioMin - 1)));
  const dispersion = clamp01(1 - m.top10Share / cfg.strategy.filters.top10MaxShare);
  const w = e.scoreWeights;
  const score = w.netBuy * netBuy + w.buyers * buyers + w.ratio * ratio + w.dispersion * dispersion;
  return { netBuy, buyers, ratio, dispersion, score };
}

export interface TokenContext {
  /** Reservas virtuales iniciales de SOL (lamports) del CreateEvent. */
  initialVSolLamports: number;
}

/** Curvas con reservas virtuales iniciales por debajo de esto (quote distinto de SOL vía router, visto en el fixture) no se operan. */
export const MIN_INITIAL_VSOL_LAMPORTS = 1_000_000_000;

/** Veredicto sobre el token (sin mirar la cartera). */
export function evaluateCandidate(m: TokenMetrics, token: TokenContext, cfg: LabConfig = LAB_CONFIG): Verdict {
  const s = cfg.strategy;
  const score = scoreCandidate(m, cfg);
  const discard = (reason: DiscardReason): Verdict => ({ enter: false, reason, score });
  if (m.ageMs < s.ageMinMs) return discard("too_young");
  if (m.ageMs > s.ageMaxMs) return discard("too_old");
  if (m.tradesSeen < s.minTradesForCandidate) return discard("inactive");
  if (m.gapped) return discard("data_gap");
  if (m.migrated) return discard("migrated");
  if (token.initialVSolLamports < MIN_INITIAL_VSOL_LAMPORTS) return discard("curve_atypical");
  const f = s.filters;
  if (m.top10Share > f.top10MaxShare) return discard("top10_concentrated");
  if (m.earlyWalletsShare > f.earlyWalletsMaxShare) return discard("early_wallets");
  if (f.devMustNotSell && m.devSold) return discard("dev_sold");
  if (m.volumeSol < f.minVolumeSol) return discard("low_volume");
  if (m.holders < f.minHolders) return discard("few_holders");
  if (m.realSol >= cfg.sim.noEntryAboveRealSol) return discard("near_graduation");
  const e = s.entry;
  if (m.netBuySol < e.netBuySolMin) return discard("low_net_buy");
  if (m.uniqueBuyers < e.uniqueBuyersMin) return discard("few_buyers");
  if (m.buySellRatio < e.buySellRatioMin) return discard("low_buy_sell_ratio");
  if (score.score < e.scoreThreshold) return discard("low_score");
  return { enter: true, reason: "enter", score };
}

export interface PortfolioContext {
  openPositions: number;
  cashSol: number;
  alreadyOpen: boolean;
  alreadyTraded: boolean;
}

/** Veredicto de cartera (tras el del token): tamaño, K posiciones, sin re-entrada. */
export function evaluatePortfolio(p: PortfolioContext, cfg: LabConfig = LAB_CONFIG): { ok: true; sizeSol: number } | { ok: false; reason: DiscardReason } {
  const z = cfg.strategy.sizing;
  if (p.alreadyOpen) return { ok: false, reason: "already_open" };
  if (cfg.strategy.exits.noReentryAfterStop && p.alreadyTraded) return { ok: false, reason: "already_traded" };
  if (p.openPositions >= z.maxPositions) return { ok: false, reason: "max_positions" };
  const size = p.cashSol * z.fractionOfBalance;
  if (size < z.minOrderSol || size + cfg.sim.txFeeSol > p.cashSol) return { ok: false, reason: "insufficient_balance" };
  return { ok: true, sizeSol: size };
}

export type ExitReason = "stop" | "trailing" | "take_profit" | "dev_sold" | "flow_reversal" | "time_stop" | "migration" | "hard_max_hold";

export interface ExitContext {
  /** P&L ejecutable (venta neta de costes vs coste total), en puntos porcentuales. */
  execPnlPct: number;
  /** P&L ejecutable justo tras el fill de entrada (negativo: costes de ida y vuelta). El stop mide la caída desde aquí. */
  entryExecPnlPct: number;
  /** Máximo P&L ejecutable visto desde la entrada. */
  peakExecPnlPct: number;
  heldMs: number;
  devSold: boolean;
  migrated: boolean;
  reversalNetSol: number;
  /** Niveles de toma de ganancia ya ejecutados (índices en cfg.strategy.exits.takeProfit). */
  takeProfitDone: readonly number[];
}

export interface ExitDecision {
  reason: ExitReason;
  /** Fracción de la posición ORIGINAL a vender (1 = todo). */
  fraction: number;
  takeProfitIndex?: number;
}

/** Primera regla de salida que dispara, en orden de prioridad. */
export function evaluateExit(c: ExitContext, cfg: LabConfig = LAB_CONFIG): ExitDecision | null {
  const x = cfg.strategy.exits;
  if (c.heldMs >= x.hardMaxHoldMs) return { reason: "hard_max_hold", fraction: 1 };
  if (c.migrated) return { reason: "migration", fraction: 1 };
  if (c.execPnlPct - c.entryExecPnlPct <= x.stopPct) return { reason: "stop", fraction: 1 };
  if (x.exitOnDevSell && c.devSold) return { reason: "dev_sold", fraction: 1 };
  if (c.peakExecPnlPct >= x.trailingActivatePct && c.execPnlPct <= c.peakExecPnlPct - x.trailingDropPct) return { reason: "trailing", fraction: 1 };
  if (c.reversalNetSol <= -x.reversalNetSol) return { reason: "flow_reversal", fraction: 1 };
  if (c.heldMs >= x.timeStopMs) return { reason: "time_stop", fraction: 1 };
  for (let i = 0; i < x.takeProfit.length; i++) {
    const tp = x.takeProfit[i];
    if (!c.takeProfitDone.includes(i) && c.execPnlPct >= tp.atPct) return { reason: "take_profit", fraction: tp.fraction, takeProfitIndex: i };
  }
  return null;
}
