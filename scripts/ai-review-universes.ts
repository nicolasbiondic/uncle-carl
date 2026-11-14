// The two stock sleeves' own universes, as the live strategy definitions say them (src/portfolios/builtin.ts). Shared by
// scripts/ai-review-casefile.ts (the case file) and scripts/ai-review-report.ts (the misses). src/ai-review/ imports no portfolio
// module (scripts/ai-review.test.ts, "src/ai-review stays pure"), so the universes are read here, on the scripts side.
import { builtinPortfolio, STOCK_SLEEVE_BUILTIN_DEFINITION } from "../src/portfolios/builtin";
import type { SleeveId } from "../src/ai-review/contract";

export function universeOf(sleeve: SleeveId): string[] {
  const params = builtinPortfolio(STOCK_SLEEVE_BUILTIN_DEFINITION[sleeve]).params as any;
  const u = params?.strategy?.universe;
  if (!Array.isArray(u) || u.length === 0) throw new Error(`no universe for ${sleeve}`);
  return u as string[];
}

export const stockUniverses = (): Record<SleeveId, string[]> => ({ momentum_stocks: universeOf("momentum_stocks"), meanrev_stocks: universeOf("meanrev_stocks") });
