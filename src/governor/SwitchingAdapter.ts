// ══════════════════════════════════════════════
// SwitchingAdapter — pre-trade guards in front of a LIVE sleeve's broker adapter
// ══════════════════════════════════════════════
//
// Thin wrapper over the real broker adapter of a momentum sleeve. The name
// dates from the live/shadow routing it did until 2026-11-07 (orders went to
// a zero-capital ShadowAdapter book when sleeve_modes said shadow); the owner
// had the shadow mode removed, so today every order reaches the real broker
// and this class only adds the two guards that must sit in front of EVERY
// opening order, whatever engine path produced it:
//   openPosition   → RiskEngine veto first (account-identity HALT, REDUCING,
//                    notional cap, rate limit — src/risk/RiskEngine.ts), then
//                    the TRADING_ENABLED maintenance backstop, then the real
//                    broker.
//   scalePosition  → a reduction is de-risking and passes straight through
//                    (RW4a exposure control); an add-back is an ENTRY and is
//                    gated like openPosition.
//   closePosition  → straight to the real broker. NEVER passes through the
//                    RiskEngine veto — see its docstring.
//   getOpenPositions / getEquity / getRealisedPnlSince / fetchCandles /
//   fetchDailyBars / fetchDailyCloses → real adapter.

import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../strategies/momentum/Rebalancer";
import type { OHLCV } from "../utils/types";
import { isTradingEnabled } from "../config";
import { RiskEngine, getDefaultRiskEngine } from "../risk/RiskEngine";

export class SwitchingAdapter implements MomentumBrokerAdapter {
  constructor(
    private sleeve: string,
    private real: MomentumBrokerAdapter,
    /** Pre-trade veto (src/risk/RiskEngine.ts). Defaults to the shared
     *  lazy singleton — default config `{}` + state ACTIVE is a no-op, so
     *  every existing call site is unaffected unless something explicitly
     *  configures limits or flips the TradingState. Injectable for tests. */
    private riskEngine: RiskEngine = getDefaultRiskEngine(),
  ) {}

  async getOpenPositions(): Promise<CurrentPosition[]> {
    return this.real.getOpenPositions();
  }

  async getEquity(): Promise<number> {
    return this.real.getEquity();
  }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    return this.real.getRealisedPnlSince(epochMs);
  }

  async openPosition(action: Parameters<MomentumBrokerAdapter["openPosition"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    // Global pre-trade veto (src/risk/RiskEngine.ts): a HALTED or REDUCING
    // TradingState (or a configured notional cap/rate limit) is meant to
    // stop new exposure everywhere. Runs first, before the TRADING_ENABLED
    // backstop: the two gates are independent and additive (either alone is
    // enough to block an open). closePosition below deliberately never
    // calls this — a risk veto must never block getting OUT of a position.
    const veto = this.riskEngine.evaluateSubmit({
      sleeve: this.sleeve,
      symbol: action.symbol,
      side: action.side,
      notionalUsd: action.notionalUsd,
    });
    if (!veto.allow) return { ok: false, reason: veto.code };

    // Maintenance kill-switch backstop (TRADING_ENABLED=false, src/config/
    // index.ts): blocks ONLY new opens — closes/stops keep running. The
    // engines already gate entries upstream (quietly, before any adapter
    // call); this line is defence in depth so NO code path can place a real
    // opening order while the switch is off. If it ever fires repeatedly,
    // sleeveOutput's consecutive-failure page is the CORRECT signal that some
    // path bypassed the engine gate. closePosition below is deliberately
    // untouched — closes must always work.
    if (!isTradingEnabled()) return { ok: false, reason: "trading_disabled" };
    return this.real.openPosition(action);
  }

  async closePosition(action: Parameters<MomentumBrokerAdapter["closePosition"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    // Deliberately does NOT call this.riskEngine.evaluateSubmit — same
    // principle as NautilusTrader's RiskEngine being absent from cancel/
    // query: a risk limit (HALTED/REDUCING/notional cap/rate limit) must
    // NEVER prevent closing an existing position. Fixed by a test in
    // SwitchingAdapter.test.ts ("RiskEngine veto never applies to
    // closePosition, in any TradingState").
    return this.real.closePosition(action);
  }

  /**
   * Exposure-control resize (RW4a, 2026-10-23). A reduction (factor < 1) is
   * de-risking and, like a close, NEVER meets the RiskEngine veto or the
   * TRADING_ENABLED backstop. An add-back (factor > 1) is an ENTRY: it passes
   * both, exactly like openPosition, with the add's notional = (factor − 1) ×
   * the held position's mark notional, so the per-order cap applies too.
   * A real adapter without the method answers ok:false "unsupported" rather
   * than emulating a close+reopen; the engine logs it per tick.
   */
  async scalePosition(action: { symbol: string; side: "buy" | "sell"; factor: number; reason?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.real.scalePosition) return { ok: false, reason: "real adapter has no scalePosition (unsupported)" };
    if (action.factor > 1) {
      // The add's notional for the veto = (factor − 1) × the held position's
      // mark notional (one read on a rare event).
      const held = (await this.real.getOpenPositions()).find(p => p.symbol === action.symbol && p.side === action.side);
      if (!held) return { ok: false, reason: "no held position to add to" };
      const veto = this.riskEngine.evaluateSubmit(
        { sleeve: this.sleeve, symbol: action.symbol, side: action.side, notionalUsd: (action.factor - 1) * Math.abs(held.notional), quantity: (action.factor - 1) * held.quantity },
        { currentPositionSide: action.side, currentPositionQty: held.quantity },
      );
      if (!veto.allow) return { ok: false, reason: veto.code };
      if (!isTradingEnabled()) return { ok: false, reason: "trading_disabled" };
    }
    return this.real.scalePosition(action);
  }

  async fetchCandles(symbol: string, bars: number, opts?: { strictVenue?: boolean }): Promise<OHLCV[]> {
    return opts ? this.real.fetchCandles(symbol, bars, opts) : this.real.fetchCandles(symbol, bars);
  }
  async fetchDailyBars(symbol: string, days: number): Promise<OHLCV[]> {
    return await this.real.fetchDailyBars?.(symbol, days) ?? [];
  }

  /** Market-trend gate data (optional interface method): a real adapter
   *  without the method = no data → the engine's gate fails OPEN (its
   *  documented contract). */
  async fetchDailyCloses(symbol: string, days: number, opts?: { strictUtc?: boolean }): Promise<number[]> {
    if (!this.real.fetchDailyCloses) return [];
    return opts ? this.real.fetchDailyCloses(symbol, days, opts) : this.real.fetchDailyCloses(symbol, days);
  }
}
