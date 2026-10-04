// ══════════════════════════════════════════════
// CPCV demo — one backtest number vs a distribution of paths
// ══════════════════════════════════════════════
//
// Runs a toy momentum rule over a synthetic random-walk price series and
// scores it with CombinatorialPurgedCV (10 folds, 2 test folds → 45 splits
// recombined into 9 independent backtest paths). Prints the per-path returns
// and the spread. Read the spread, not the mean: if the median is positive
// but p10 is deeply negative, that IS the risk profile of the strategy —
// a single-trajectory backtest would have shown you one of these 9 numbers
// at random and called it truth.
//
// Standalone illustration only — NOT wired into the walk-forward harness.
//
//   bun run scripts/cpcv-demo.ts [seed]

import { CombinatorialPurgedCV } from "../src/backtest/cpcv";

// Deterministic LCG so runs are reproducible; pass a seed to see how much
// the conclusion moves on a different draw of pure noise.
let seed = Number(process.argv[2] ?? 42);
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296 - 0.5;
};

// Synthetic daily log-price: zero-drift random walk (i.e., NO real edge).
const N = 1000;
const logPrice: number[] = [0];
for (let t = 1; t < N; t++) logPrice.push(logPrice[t - 1] + rand() * 0.04);

// Toy rule "trained" per split: pick the lookback (5/10/20) with the best
// in-sample momentum autocorrelation, then trade it out-of-sample.
const LOOKBACKS = [5, 10, 20];
function dailyPnl(lookback: number, t: number): number {
  if (t < lookback + 1) return 0;
  const mom = logPrice[t - 1] - logPrice[t - 1 - lookback];
  const ret = logPrice[t] - logPrice[t - 1];
  return Math.sign(mom) * ret;
}
function score(lookback: number, index: number[]): number {
  return index.reduce((s, t) => s + dailyPnl(lookback, t), 0);
}

const cv = new CombinatorialPurgedCV({
  nFolds: 10,
  nTestFolds: 2,
  purgedSize: 20, // ≥ longest lookback: momentum labels overlap 20 bars
  embargoSize: 5,
});
const splits = cv.split(N);
const pathIds = cv.getPathIds();

const pathReturns = new Array<number>(cv.nTestPaths).fill(0);
splits.forEach((s, i) => {
  // "Train": pick best lookback in-sample.
  const best = LOOKBACKS.reduce((a, b) =>
    score(a, s.trainIndex) >= score(b, s.trainIndex) ? a : b
  );
  // Each test fold's out-of-sample pnl accrues to ITS path — this stitching
  // via getPathIds() is what turns 45 splits into 9 coherent trajectories.
  s.testIndexList.forEach((fold, j) => {
    pathReturns[pathIds[i][j]] += score(best, fold);
  });
});

const sorted = [...pathReturns].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const fmt = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`CPCV: ${cv.nSplits} splits → ${cv.nTestPaths} backtest paths (seed ${process.argv[2] ?? 42})`);
console.log(`per-path log-return: [${pathReturns.map(fmt).join(", ")}]`);
console.log(`p10=${fmt(pct(0.1))}  median=${fmt(pct(0.5))}  p90=${fmt(pct(0.9))}`);
console.log(
  `\nThe series has ZERO real edge — any single path above is the number a` +
    `\none-trajectory backtest would have reported. The spread is the lesson.`
);
