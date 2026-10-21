# Portfolio engine: integration notes

The plan and the pre-registration: `docs/reports/RW-reescritura-rentable.md`.
The contract: `types.ts`. The pure core (`index.ts`): `decide`,
`planOrders`, signals, construction, stops, costs. The research simulator:
`scripts/portfolio-replay.ts`; the live runner: `live/` (built, not wired to
any sleeve: D1–D3 failed their criteria).

## Calling the core

- One decision per session: `decide()` with `view.asOf` = the last completed
  session and `executionSession` = the session the orders execute in. D2
  reconstitutes when `executionSession` is the first session of a month,
  with that session's membership; prices still stop at `asOf`.
- Size orders with `planOrders(target, book, prices, rules)`, where `prices`
  are the reference prices the caller marks the book with.
- After the fills, call `decide()` once more with the actual positions, the
  memory returned by the first call and the same view and
  `executionSession`. Persist that second memory and sync its `stops`; do not
  submit a second rebalance. This sets the stop levels from the real average
  entry.
- Persist `TargetBook.memory` unchanged, per strategy version. Two versions
  never share memory.

## Initial states

- Trend signals start off; the D2 overlay starts off. A first decision inside
  a hysteresis band keeps that state.

## Live venues

- `venues/binance.ts` takes `claimOrderId(id)`: it must record the id
  atomically in persistent storage before returning `true`, and never expire
  it. That is what keeps a retry after a restart from sending a second order.
- Alpaca: fractional market DAY orders; never a full-position DELETE
  (AGENTS.md, "Alpaca close semantics").
