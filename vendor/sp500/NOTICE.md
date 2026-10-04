# S&P 500 historical membership — vendored data

- `sp500_ticker_start_end.csv` is vendored verbatim from
  [fja05680/sp500](https://github.com/fja05680/sp500) (MIT license — see
  `LICENSE` in this directory), pinned to commit
  `a2430f2af0c79ddf0748e91de11bdeb1616ab5a7` (2026-09-07) for
  reproducibility.
- sha256: `b2f4fe2f2e4dce8eaf0eb4fbd3946a32a20c1ddfe69687dfca3b6b59a0b71f9f`
- Semantics (verified 2026-10-02 against the same commit's
  "S&P 500 Historical Components & Changes (Updated).csv", 62/62 sampled
  composition dates reproduced exactly):
  - one row per membership TRAMO (`ticker,start_date,end_date`); 1262 rows,
    52 tickers with more than one tramo;
  - `start_date` is INCLUSIVE (first date the ticker is in the composition);
  - `end_date` is EXCLUSIVE (the removal's effective date — the ticker is
    NOT in the composition on that date); empty = current member.
- The much larger components-by-date CSV is NOT vendored (7.8 MB); it is
  fetched from the pinned commit by `scripts/import-sp500-membership.ts`
  for validation only.
- Research use only: this data feeds the `index_membership` table of the
  RESEARCH historical DB (point-in-time universe replays). Nothing live
  reads it.
