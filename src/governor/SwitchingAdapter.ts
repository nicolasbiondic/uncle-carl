// ══════════════════════════════════════════════
// SwitchingAdapter — governor-aware routing for LIVE sleeves
// ══════════════════════════════════════════════
//
// Thin wrapper over a real broker adapter + a shadow adapter for the same
// sleeve. Routing rules:
//   openPosition   → RiskEngine veto first (see below), then governor mode:
//                    live → real, shadow → shadow book.
//   closePosition  → if the LIVE account has an open DB row for the symbol,
//                    close on the REAL broker (never strand a real position
//                    after a demotion); otherwise route to shadow. NEVER
//                    passes through the RiskEngine veto — see its docstring.
//   getOpenPositions → live rows always; PLUS shadow rows when mode=shadow,
//                    so a demoted engine keeps managing residual real
//                    positions to exit while opening only simulated ones.
//   getEquity / getRealisedPnlSince / fetchCandles → real adapter
//                    (equity basis unchanged across demotion).

import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../strategies/momentum/Rebalancer";
import type { OHLCV } from "../utils/types";
import type { ModeSource } from "./SleeveGovernor";
import { getOpenTrades } from "../db/database";
import { isTradingEnabled } from "../config";
import { RiskEngine, getDefaultRiskEngine } from "../risk/RiskEngine";

export class SwitchingAdapter implements MomentumBrokerAdapter {
  constructor(
    private sleeve: string,
    private modes: ModeSource,
    private real: MomentumBrokerAdapter,
    private shadow: MomentumBrokerAdapter,
    /** trades.account_id of the LIVE book (e.g. "momentum_stocks"). */
    private liveAccountId: string,
    /** Pre-trade veto (src/risk/RiskEngine.ts). Defaults to the shared
     *  lazy singleton — default config `{}` + state ACTIVE is a no-op, so
     *  every existing call site is unaffected unless something explicitly
     *  configures limits or flips the TradingState. Injectable for tests. */
    private riskEngine: RiskEngine = getDefaultRiskEngine(),
  ) {}

  private mode() {
    // No explicit default here: an explicit "live" would override the
    // sleeve's own registered fallback (getMode's `def ?? registered ?? "live"`)
    // whenever no sleeve_modes row exists yet, silently defeating a
    // registered kind:"shadow" default. Let SleeveGovernor own the fallback.
    return this.modes.getMode(this.sleeve);
  }

  async getOpenPositions(): Promise<CurrentPosition[]> {
    const live = await this.real.getOpenPositions();
    if (this.mode() === "live") return live;
    return [...live, ...(await this.shadow.getOpenPositions())];
  }

  async getEquity(): Promise<number> {
    return this.real.getEquity();
  }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    return this.real.getRealisedPnlSince(epochMs);
  }

  async openPosition(action: Parameters<MomentumBrokerAdapter["openPosition"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    // Global pre-trade veto (src/risk/RiskEngine.ts): applies to EVERY
    // sleeve's opens regardless of live/shadow routing below — a HALTED or
    // REDUCING TradingState (or a configured notional cap/rate limit) is
    // meant to stop new exposure everywhere, not just on the real broker.
    // Runs first, before mode routing and the TRADING_ENABLED backstop: the
    // two gates are independent and additive (either alone is enough to
    // block an open). closePosition below deliberately never calls this —
    // a risk veto must never block getting OUT of a position.
    const veto = this.riskEngine.evaluateSubmit({
      sleeve: this.sleeve,
      symbol: action.symbol,
      side: action.side,
      notionalUsd: action.notionalUsd,
    });
    if (!veto.allow) return { ok: false, reason: veto.code };

    if (this.mode() !== "live") return this.shadow.openPosition(action);
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

  async closePosition(action: { symbol: string; side: "buy" | "sell" }): Promise<{ ok: boolean; reason?: string }> {
    // Deliberately does NOT call this.riskEngine.evaluateSubmit — same
    // principle as NautilusTrader's RiskEngine being absent from cancel/
    // query: a risk limit (HALTED/REDUCING/notional cap/rate limit) must
    // NEVER prevent closing an existing position. Fixed by a test in
    // SwitchingAdapter.test.ts ("RiskEngine veto never applies to
    // closePosition, in any TradingState").
    //
    // Real broker position wins regardless of mode — a demotion must never
    // strand an open broker position with no exit path.
    const hasLiveRow = getOpenTrades(this.liveAccountId).some(t => t.symbol === action.symbol);
    return hasLiveRow
      ? this.real.closePosition(action)
      : this.shadow.closePosition(action);
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    return this.real.fetchCandles(symbol, bars);
  }

  /** Market-trend gate data (optional interface method): data reads route to
   *  the real adapter like fetchCandles — mode never changes what the market
   *  looks like. A real adapter without the method = no data → the engine's
   *  gate fails OPEN (its documented contract). */
  async fetchDailyCloses(symbol: string, days: number): Promise<number[]> {
    return this.real.fetchDailyCloses ? this.real.fetchDailyCloses(symbol, days) : [];
  }
}
