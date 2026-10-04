// ══════════════════════════════════════════════
// CombinatorialPurgedCV — multiple backtest paths instead of one
// ══════════════════════════════════════════════
//
// WHY THIS EXISTS: a single backtest trajectory is one draw from a noisy
// process. This week we measured that 5 bps of slippage flips a window from
// +170% to −15%, and a parameter nudge moves results ±180pp — with ONE
// trajectory you cannot tell signal from luck. CPCV (López de Prado, AFML
// 2018, ch. 12) splits the series into `nFolds` groups and tests every
// C(nFolds, nTestFolds) combination, then recombines the out-of-sample test
// folds into `nTestPaths = C(n,k)·k/n` INDEPENDENT full-length backtest
// paths. E.g. nFolds=10, nTestFolds=2 → 45 splits → 9 paths. Your "+170%"
// becomes a DISTRIBUTION of 9 path returns.
//
// HOW TO READ THE DISPERSION (this is the point, don't average it away):
//   • Median path return ≈ the strategy's typical outcome.
//   • Spread (p10..p90) ≈ trajectory luck. If median is +20% but p10 is
//     −40%, that −40% is REAL RISK information: a plausible live outcome,
//     not noise to smooth over. A decision that only survives the best
//     paths is a decision made on luck.
//   • If the sign of the median flips when you add purge/embargo, your
//     edge was label leakage, not alpha.
//
// PURGE / EMBARGO (leakage control):
//   • purgedSize: drop that many observations from the train set
//     immediately BEFORE and immediately AFTER each test block — labels
//     built from overlapping windows (returns over h bars, indicators with
//     lookback) leak across the boundary otherwise. Set it ≥ your label
//     horizon / longest indicator lookback, in bars.
//   • embargoSize: drop that many ADDITIONAL train observations after each
//     test block — serial correlation (ARMA-ish features) leaks forward
//     even past the label horizon.
//
// This is a faithful TypeScript port of skfolio's CombinatorialPurgedCV
// (skfolio/skfolio, BSD-3-Clause, src/skfolio/model_selection/
// _combinatorial.py) — index generation only, no plotting/pandas. Its
// doctests are reproduced verbatim in cpcv.test.ts as acceptance tests,
// plus extra cases cross-checked against the reference numpy code.
//
// One deliberate deviation, flagged: for series where nSamples % nFolds is
// large relative to the fold size, the reference leaves trailing
// observations assigned to phantom folds ≥ nFolds (they end up in EVERY
// train set and no test set). We clamp them into the last fold instead —
// identical output on every doctest and every evenly-divisible case, saner
// on the ragged ones.
//
// NOT integrated into the walk-forward harness yet — standalone module.
// See scripts/cpcv-demo.ts for a runnable illustration.

const MAX_COMBINATIONS = 100_000;

export interface CpcvOptions {
  /** Number of folds. Must be ≥ 3. Default 10 (matches skfolio). */
  nFolds?: number;
  /** Number of test folds per split. ≥ 2 and < nFolds. Default 8 (matches skfolio). */
  nTestFolds?: number;
  /** Observations purged from train immediately before AND after each test block. Default 0. */
  purgedSize?: number;
  /** Additional observations dropped from train immediately after each test block. Default 0. */
  embargoSize?: number;
}

export interface CpcvSplit {
  /** Indices to train on (purge/embargo already removed). Ascending. */
  trainIndex: number[];
  /**
   * One index array per test fold, in ascending fold order. Kept separate
   * (not concatenated) because each test fold belongs to a DIFFERENT
   * backtest path — see getPathIds().
   */
  testIndexList: number[][];
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < Math.min(k, n - k); i++) {
    r = (r * (n - i)) / (i + 1);
  }
  return Math.round(r);
}

/** All C(n,k) combinations of {0..n-1}, lexicographic (itertools.combinations order). */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

export class CombinatorialPurgedCV {
  readonly nFolds: number;
  readonly nTestFolds: number;
  readonly purgedSize: number;
  readonly embargoSize: number;

  constructor(options: CpcvOptions = {}) {
    const { nFolds = 10, nTestFolds = 8, purgedSize = 0, embargoSize = 0 } = options;

    if (!Number.isInteger(nFolds)) {
      throw new Error(`nFolds must be an integer, got ${nFolds}`);
    }
    if (!Number.isInteger(nTestFolds)) {
      throw new Error(`nTestFolds must be an integer, got ${nTestFolds}`);
    }
    if (nFolds <= 2) {
      throw new Error(`nFolds must be at least 3, got nFolds=${nFolds}`);
    }
    if (nTestFolds <= 1) {
      throw new Error(
        `nTestFolds must be at least 2, got nTestFolds=${nTestFolds} ` +
          `(for a single test fold use plain walk-forward/KFold)`
      );
    }
    if (nTestFolds >= nFolds) {
      throw new Error(
        `nFolds must be greater than nTestFolds, got nFolds=${nFolds}, nTestFolds=${nTestFolds}`
      );
    }
    if (purgedSize < 0) throw new Error(`purgedSize cannot be negative, got ${purgedSize}`);
    if (embargoSize < 0) throw new Error(`embargoSize cannot be negative, got ${embargoSize}`);

    const nCombinations = comb(nFolds, nTestFolds);
    if (nCombinations > MAX_COMBINATIONS) {
      throw new Error(
        `nFolds=${nFolds}, nTestFolds=${nTestFolds} produces ${nCombinations} splits ` +
          `(max ${MAX_COMBINATIONS}); each split is a full backtest — reduce nFolds or ` +
          `move nTestFolds further from nFolds/2`
      );
    }

    this.nFolds = nFolds;
    this.nTestFolds = nTestFolds;
    this.purgedSize = purgedSize;
    this.embargoSize = embargoSize;
  }

  /** Number of train/test combinations = C(nFolds, nTestFolds). */
  get nSplits(): number {
    return comb(this.nFolds, this.nTestFolds);
  }

  /** Number of full backtest paths recombinable from the test folds. */
  get nTestPaths(): number {
    return (this.nSplits * this.nTestFolds) / this.nFolds;
  }

  /** Fold ids used as test set in each split; shape (nSplits, nTestFolds), lexicographic. */
  get testSetIndex(): number[][] {
    return combinations(this.nFolds, this.nTestFolds);
  }

  /**
   * recombinedPaths[fold] = ascending split ids in which `fold` is a test
   * fold; shape (nFolds, nTestPaths). Column p of every row assembles
   * backtest path p: path p tests fold f using the model trained in split
   * recombinedPaths[f][p].
   */
  private get recombinedPaths(): number[][] {
    const paths: number[][] = Array.from({ length: this.nFolds }, () => []);
    this.testSetIndex.forEach((folds, splitId) => {
      for (const f of folds) paths[f].push(splitId); // splitId ascending ⇒ rows sorted
    });
    return paths;
  }

  /**
   * pathIds[i][j] = backtest path that test fold j of split i belongs to
   * (j indexes testIndexList / testSetIndex[i], ascending fold order).
   * This is the piece homemade CPCV implementations omit: without it the 45
   * test results cannot be stitched back into 9 coherent trajectories.
   * Matches skfolio's get_path_ids() exactly.
   */
  getPathIds(): number[][] {
    const recombined = this.recombinedPaths;
    const pathIds: number[][] = [];
    for (let i = 0; i < this.nSplits; i++) {
      const row: number[] = [];
      // scan folds ascending — same row-major order as np.argwhere
      for (let f = 0; f < this.nFolds; f++) {
        const p = recombined[f].indexOf(i); // split appears ≤ once per fold row
        if (p !== -1) row.push(p);
      }
      pathIds.push(row);
    }
    return pathIds;
  }

  /**
   * Generate all splits for a series of `nSamples` observations.
   * Returns an array (not a generator) — nSplits is capped and small.
   */
  split(nSamples: number): CpcvSplit[] {
    if (!Number.isInteger(nSamples) || nSamples < this.nFolds) {
      throw new Error(
        `nSamples must be an integer ≥ nFolds=${this.nFolds}, got ${nSamples}`
      );
    }
    const foldSize = Math.floor(nSamples / this.nFolds);
    const minFoldSize = foldSize;
    if (this.purgedSize + this.embargoSize >= minFoldSize - 1) {
      throw new Error(
        `purgedSize + embargoSize (${this.purgedSize + this.embargoSize}) must be ` +
          `smaller than the fold size minus one (fold size = ${minFoldSize}); ` +
          `use more observations or fewer folds`
      );
    }

    // Fold assignment: contiguous blocks of foldSize; remainder clamped into
    // the last fold (see header note on the deliberate deviation).
    const foldIndexNum = new Array<number>(nSamples);
    for (let t = 0; t < nSamples; t++) {
      foldIndexNum[t] = Math.min(Math.floor(t / foldSize), this.nFolds - 1);
    }
    const foldIndex: number[][] = Array.from({ length: this.nFolds }, () => []);
    for (let t = 0; t < nSamples; t++) foldIndex[foldIndexNum[t]].push(t);

    const testSetIndex = this.testSetIndex;
    const splits: CpcvSplit[] = [];

    for (let i = 0; i < this.nSplits; i++) {
      // state[t]: 1 = test, 0 = train, -1 = purged/embargoed
      const state = new Int8Array(nSamples);
      const testFolds = new Set(testSetIndex[i]);
      for (let t = 0; t < nSamples; t++) {
        if (testFolds.has(foldIndexNum[t])) state[t] = 1;
      }

      // Block boundaries on the PRE-purge 0/1 state (reference computes
      // np.diff before mutating). Adjacent test folds merge into one block.
      const starts: number[] = []; // first index of each contiguous test block
      const ends: number[] = []; // last index of each contiguous test block
      for (let t = 0; t < nSamples; t++) {
        if (state[t] === 1 && (t === 0 || state[t - 1] !== 1)) starts.push(t);
        if (state[t] === 1 && (t === nSamples - 1 || state[t + 1] !== 1)) ends.push(t);
      }

      // Purge before each block. Reference quirk kept: a block starting at
      // t=0 has no diff==1 edge, so nothing is purged before it.
      for (const s of starts) {
        if (s === 0) continue;
        for (let k = 0; k < this.purgedSize; k++) {
          state[Math.max(0, s - 1 - k)] = -1;
        }
      }
      // Purge + embargo after each block. Reference quirk kept: a block
      // ending at t=nSamples-1 has no diff==-1 edge, nothing removed after.
      for (const e of ends) {
        if (e === nSamples - 1) continue;
        for (let k = 0; k < this.purgedSize + this.embargoSize; k++) {
          state[Math.min(nSamples - 1, e + 1 + k)] = -1;
        }
      }

      const trainIndex: number[] = [];
      for (let t = 0; t < nSamples; t++) if (state[t] === 0) trainIndex.push(t);
      const testIndexList = testSetIndex[i].map((f) => foldIndex[f]);
      splits.push({ trainIndex, testIndexList });
    }
    return splits;
  }
}
