// ═══ Portfolio engine — build the engines a resolved wiring asks for (src/index.ts's one call) ═══
//
// resolvePortfolioWiring (cutover.ts) decides; this builds. Every engine is CONSTRUCTED before the
// incumbents are (index.ts), because a live engine that cannot be built (no venue client, no
// historical.db, bad symbols) must leave its sleeve to the incumbent: the incumbent is gated off only
// for sleeves whose engine exists. start() afterwards only sets timers (heartbeat + tick loop).

import type { Database } from "bun:sqlite";
import type { AlpacaExecutor } from "../../executor/alpaca-executor";
import type { BinanceUsdmTransport } from "../../executor/binance/usdmTransport";
import type { PortfolioEnginePlan } from "../../portfolios/types";
import { buildAlpacaPortfolioEngine, buildPortfolioEngine, openHistoricalDb, type BuildDeps } from "./factory";
import { claimPortfolioOrderId } from "./persistence";
import type { PortfolioEngine } from "./PortfolioEngine";
import { BinanceVenueAdapter } from "./venues/binance";
import type { PortfolioWiring, WiringProblem } from "./cutover";

export interface EngineSources {
  alpacaExecutor?: AlpacaExecutor | null;
  binanceTransports: { binance_usdm?: BinanceUsdmTransport | null; binance_usdc?: BinanceUsdmTransport | null };
  /** Read-only historical.db (opened once, shared). Default: ./data/historical.db. */
  historicalDb?: () => Database;
  claimOrderId?: (id: string) => Promise<boolean>;
  heartbeats?: BuildDeps["heartbeats"];
  now?: () => number;
  /** Test seams (alert, tradingEnabled, tick cadence…). */
  engineOverrides?: BuildDeps["engineOverrides"];
}

export interface BuiltPortfolioEngines {
  /** sleeve → its live engine (the incumbent must not run). */
  live: Map<string, PortfolioEngine>;
  observers: PortfolioEngine[];
  problems: WiringProblem[];
}

export function buildPortfolioEngines(wiring: PortfolioWiring, src: EngineSources): BuiltPortfolioEngines {
  const out: BuiltPortfolioEngines = { live: new Map(), observers: [], problems: [...wiring.problems] };
  let hist: Database | null = null;
  const historicalDb = () => (hist ??= (src.historicalDb ?? (() => openHistoricalDb()))());
  const build = (plan: PortfolioEnginePlan): PortfolioEngine => {
    const p = plan.params;
    const deps: Omit<BuildDeps, "venue"> = {
      historicalDb: historicalDb(), heartbeats: src.heartbeats, now: src.now, engineOverrides: src.engineOverrides,
    };
    if (p.venue === "alpaca") {
      if (!src.alpacaExecutor) throw new Error("no Alpaca executor");
      return buildAlpacaPortfolioEngine(plan, src.alpacaExecutor, deps);
    }
    const transport = src.binanceTransports[p.venue];
    if (!transport) throw new Error(`no ${p.venue} transport`);
    if (p.strategy.kind === "factorCore") throw new Error("factorCore has no Binance venue");
    const venue = new BinanceVenueAdapter({
      venue: p.venue, sleeveId: p.sleeve ?? plan.portfolioId, symbols: p.strategy.universe,
      transport, claimOrderId: src.claimOrderId ?? claimPortfolioOrderId,
    });
    return buildPortfolioEngine(plan, { ...deps, venue });
  };
  for (const [plans, isLive] of [[wiring.live, true], [wiring.observers, false]] as const) {
    for (const plan of plans) {
      const sleeve = plan.params.sleeve ?? plan.portfolioId;
      try {
        const engine = build(plan);
        if (isLive) out.live.set(sleeve, engine); else out.observers.push(engine);
      } catch (e: any) {
        out.problems.push({
          definitionId: plan.portfolioId, sleeve, severity: isLive ? "live_refused" : "ignored",
          message: `engine could not be built (${e?.message ?? e})${isLive ? ": the incumbent keeps managing the sleeve" : ""}`,
        });
      }
    }
  }
  return out;
}

/** Start the engines that survived the single-manager guard. Returns the stopper. */
export function startPortfolioEngines(engines: Iterable<PortfolioEngine>): () => void {
  const started = [...engines];
  for (const e of started) e.start();
  return () => { for (const e of started) e.stop(); };
}
