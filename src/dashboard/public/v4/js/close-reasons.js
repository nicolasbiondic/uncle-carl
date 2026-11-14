// One bilingual vocabulary for persisted close reasons, shared with Telegram.
const limit = ["5-day limit", "cierre por tiempo máximo (5 días)"];
const stop = ["stop-loss", "cierre por límite de pérdida"];
const matched = ["matched to the broker", "cierre registrado en el broker"];
const exit = ["exit signal", "cierre por señal de salida"];
const rebalance = ["rebalance", "ajuste de la cartera"];
const emergency = ["emergency stop at the broker", "cierre de emergencia en el broker"];
export const CLOSE_REASON_WORDS = {
  MAX_HOLD: limit, TIME_STOP: limit, BREAKOUT_SHORT_TIME_STOP: limit, BREAKOUT_LONG_TIME_STOP: limit,
  STOP_LOSS: stop, STOP: stop, BREAKOUT_SHORT_STOP: stop, BREAKOUT_LONG_STOP: stop,
  TRAIL_STOP: ["trailing stop", "cierre por protección de la ganancia"],
  TRAILING_STOP: ["trailing stop", "cierre por protección de la ganancia"],
  TRAILING_SL: ["trailing stop", "cierre por protección de la ganancia"],
  BROKER_STOP_LOSS: ["stop-loss at the broker", "cierre por límite de pérdida en el broker"],
  BREAKOUT_CATASTROPHE_STOP: emergency, BREAKOUT_SHORT_CATASTROPHE_STOP: emergency, BREAKOUT_LONG_CATASTROPHE_STOP: emergency,
  BREAKOUT_SHORT_EXIT: ["breakout ended", "terminó la señal de ruptura"],
  BREAKOUT_LONG_EXIT: ["breakout ended", "terminó la señal de ruptura"],
  BREAKOUT_SHORT_PRIORITY: ["made room for a stronger breakout", "dio paso a una señal más fuerte"],
  BREAKOUT_LONG_PRIORITY: ["made room for a stronger breakout", "dio paso a una señal más fuerte"],
  BREAKOUT_SHORT_DRAWDOWN: ["drawdown control", "ajuste por caída del patrimonio"],
  BREAKOUT_LONG_DRAWDOWN: ["drawdown control", "ajuste por caída del patrimonio"],
  TREND_EXIT: ["trend ended", "terminó la tendencia"], SMA_EXIT: exit, MEANREV_EXIT: exit, SIGNAL_EXIT: exit,
  IDLE_OVERLAY_EXIT: ["idle-cash position closed", "cierre de la inversión temporal del efectivo"],
  SLOT_DISPLACED: ["a stronger pick took its slot", "reemplazada por una señal más fuerte"],
  MODEL_CUTOVER: ["new model version", "cambio de modelo"],
  AI_REVIEW_EXIT: ["taken out by the AI review", "la revisión de IA la sacó"],
  MOMENTUM_REBALANCE: rebalance, PORTFOLIO_REBALANCE: rebalance, REBALANCE: rebalance,
  TAKE_PROFIT: ["profit target reached", "objetivo de ganancia alcanzado"], REVERSE_SIGNAL: exit,
  MANUAL_CLOSE: ["closed by hand", "cierre manual"],
  MANUAL_CLOSE_UNRECONCILED: matched, BROKER_GONE_404: matched, BACKFILLED_SYNC: matched,
  SYNC_DETECTED: matched, SYNC_DUP_RECONCILED: matched, MOMENTUM_RECONCILED: matched, PORTFOLIO_RECONCILED: matched,
  MEANREV_RECONCILED: matched, LEGACY_UNLABELED: ["previous position closed", "operación anterior finalizada"],
};

export function closeReasonWord(code, lang = "es") {
  const words = CLOSE_REASON_WORDS[String(code || "").toUpperCase()];
  return words?.[lang === "es" ? 1 : 0] || (lang === "es" ? "operación finalizada" : "position closed");
}
