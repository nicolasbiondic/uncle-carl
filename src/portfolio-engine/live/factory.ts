// ═══ Portfolio engine — build one from a registry definition ═══
//
// Registry side: a platform_portfolios row with template "portfolio" and
// PortfolioEngineParams (src/portfolios/types.ts) → buildPortfolioPlan gives a
// PortfolioEnginePlan (pure data). This module turns that plan plus the venue
// into a running PortfolioEngine and registers its heartbeat.
//
// src/index.ts consumes these through live/wiring.ts (observer alongside the
// incumbent, live instead of it); no sleeve is configured by the code: the
// registry definition comes from scripts/portfolio-engine-cutover.ts.

import { Database } from "bun:sqlite";
import type { AlpacaExecutor } from "../../executor/alpaca-executor";
import { heartbeats as defaultHeartbeats } from "../../ops/heartbeat";
import type { PortfolioEnginePlan } from "../../portfolios/types";
import type { MembershipView, VenueAdapter, VenueId } from "../types";
import { PortfolioEngine, type PortfolioEngineOptions } from "./PortfolioEngine";
import { HistoricalPriceView } from "./priceView";
import type { Market } from "./schedule";
import { AlpacaVenue } from "./venues/alpaca";

export interface VenueProfile {
  market: Market;
  rowMarket: "stock" | "crypto";
  quoteAsset: string;
}

export function venueProfile(venue: VenueId): VenueProfile {
  switch (venue) {
    case "alpaca": return { market: "stocks", rowMarket: "stock", quoteAsset: "USD" };
    case "binance_usdm": return { market: "crypto", rowMarket: "crypto", quoteAsset: "USDT" };
    case "binance_usdc": return { market: "crypto", rowMarket: "crypto", quoteAsset: "USDC" };
  }
}

/** historical.db, read-only: the engine never writes bars (the 04:00 cron does). */
export function openHistoricalDb(path = "./data/historical.db"): Database {
  return new Database(path, { readonly: true });
}

export interface BuildDeps {
  venue: VenueAdapter;
  historicalDb: Database;
  membership?: MembershipView;
  heartbeats?: PortfolioEngineOptions["heartbeats"];
  now?: () => number;
  /** Test seams. */
  engineOverrides?: Partial<PortfolioEngineOptions>;
}

export function buildPortfolioEngine(plan: PortfolioEnginePlan, deps: BuildDeps): PortfolioEngine {
  const p = plan.params;
  if (p.venue !== deps.venue.venue) {
    throw new Error(`portfolio '${plan.portfolioId}': params.venue ${p.venue} ≠ venue adapter ${deps.venue.venue}`);
  }
  if (p.strategy.kind === "factorCore" && !deps.membership) {
    throw new Error(`portfolio '${plan.portfolioId}': factorCore needs a MembershipView (point-in-time S&P 500 members)`);
  }
  const profile = venueProfile(p.venue);
  const dataSymbols = p.dataSymbols ?? {};
  const dataSymbol = (s: string) => dataSymbols[s] ?? s;
  const engine = new PortfolioEngine({
    accountId: p.sleeve ?? plan.portfolioId,
    strategyVersion: p.strategyVersion,
    config: p.strategy,
    capital: plan.capital,
    market: profile.market,
    rowMarket: profile.rowMarket,
    quoteAsset: profile.quoteAsset,
    venue: deps.venue,
    mode: p.runMode,
    openPriceView: (asOf, symbols) => new HistoricalPriceView({ db: deps.historicalDb, asOf, symbols, dataSymbol }),
    membership: deps.membership,
    maxStaleSymbols: p.maxStaleSymbols ?? 0,
    heartbeatName: plan.heartbeat.name,
    heartbeats: deps.heartbeats ?? defaultHeartbeats,
    now: deps.now,
    ...deps.engineOverrides,
  });
  return engine;
}

/** Stocks/ETFs: the venue over the ONE Alpaca executor the process already
 *  holds (accountManager.executor.alpaca), rules from the plan. */
export function buildAlpacaPortfolioEngine(plan: PortfolioEnginePlan, executor: AlpacaExecutor, deps: Omit<BuildDeps, "venue">): PortfolioEngine {
  const venue = AlpacaVenue.fromExecutor(executor, {
    minOrderNotional: plan.params.minOrderNotional,
    rebalanceBand: plan.params.rebalanceBand,
  });
  return buildPortfolioEngine(plan, { ...deps, venue });
}

/** Registry-level description of what the heartbeat watchdog expects. */
export function portfolioHeartbeatSpec(plan: PortfolioEnginePlan): { name: string; intervalMs: number; graceMultiplier: number } {
  return { name: plan.heartbeat.name, intervalMs: plan.heartbeat.intervalMs, graceMultiplier: plan.heartbeat.graceMultiplier ?? 5 };
}
