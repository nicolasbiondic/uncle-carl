// Pure per-symbol feature math for the AI-quorum snapshot (línea D).
// Input: daily closes OLDEST→NEWEST (last element = latest completed bar).
// Every function returns null when the history is too short — the snapshot
// ships nulls honestly instead of fabricating a number.

/** close[t] / close[t-n] − 1, null if fewer than n+1 closes. */
export function simpleReturn(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - n];
  if (!(then > 0)) return null;
  return now / then - 1;
}

/** Std dev (population) of the last `n` daily log returns. Needs n+1 closes. */
export function volatility(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (!(prev > 0) || !(closes[i] > 0)) return null;
    rets.push(Math.log(closes[i] / prev));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

/** Wilder RSI over `period` (default 14). Needs period+1 closes. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  // Wilder smoothing over the full history for stability.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** close / SMA(n) − 1, null if fewer than n closes. */
export function distanceToSMA(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  const sma = sum / n;
  if (!(sma > 0)) return null;
  return closes[closes.length - 1] / sma - 1;
}

/** Mean of the last `n` funding rates (newest-last array). Null if empty. */
export function meanFunding(rates: number[], n = 3): number | null {
  if (rates.length === 0) return null;
  const tail = rates.slice(-n);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}
