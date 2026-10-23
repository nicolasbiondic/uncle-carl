/** Public research ingestion, no strategy backtest or copy returns.
 * bun run scripts/hl-collect.ts snapshot [--top=10] [--days=30]
 * bun run scripts/hl-collect.ts history [--limit=100]  (default: every address)
 * bun run scripts/hl-collect.ts stats > /external/path/hl-stats.json
 * Dev-only hourly cron, from a checkout of this repo (flock prevents overlapping collectors):
 * 7 * * * * cd <repo> && /usr/bin/flock -n <research data dir>/hl.lock <bun> run scripts/hl-collect.ts snapshot >> <research data dir>/hl-forward.log 2>&1
 * Run history separately under the SAME flock; 47k+ addresses take many hours.
 * No current endpoint can supply lifetime fills or historical leaderboard membership.
 */
import { HyperliquidClient, collectHistory, openHyperliquid } from "./lib/hyperliquid";
import { DEFAULT_SELECTION, descriptiveStats, openSignals, takeSnapshot } from "./lib/hyperliquidResearch";

export async function main(args = process.argv.slice(2)) {
  const option = (name: string, fallback: number) => {
    const value = args.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) throw new Error(`Invalid --${name}`);
    return n;
  };
  const db = openHyperliquid();
  const client = new HyperliquidClient(db);
  try {
    switch (args[0]) {
      case "snapshot": {
        const signals = openSignals();
        try { console.log(JSON.stringify(await takeSnapshot(client, signals, { ...DEFAULT_SELECTION, topN: option("top", 10), days: option("days", 30) }))); }
        finally { signals.close(); }
        break;
      }
      case "history": {
        // Oldest checked first: repeated bounded runs eventually cover ALL ever
        // seen addresses, not just current winners. Failures remain visible.
        const addresses = db.query<{ address: string }, [number]>(`SELECT a.address FROM hl_addresses a LEFT JOIN hl_history h USING(address)
          ORDER BY coalesce(h.checked_ms,0),a.address LIMIT ?`).all(option("limit", Number.MAX_SAFE_INTEGER));
        let failures = 0;
        for (const { address } of addresses) {
          try {
            const count = await collectHistory(client, address);
            const portfolio = await client.portfolio(address);
            db.run("INSERT OR IGNORE INTO hl_portfolios VALUES (?,?,?)", [address, portfolio.observedMs, JSON.stringify(portfolio.data)]);
            console.log(JSON.stringify({ address, fills: count, status: "available-history-only" }));
          } catch (error) { failures++; console.error(address, String(error)); }
        }
        if (failures) throw new Error(`${failures} address collection failures; rerun history to retry`);
        break;
      }
      case "stats": console.log(JSON.stringify(descriptiveStats(db), null, 2)); break;
      default: throw new Error("Usage: hl-collect.ts snapshot|history|stats [--top=10] [--days=30] [--limit=100]");
    }
  } finally { db.close(); }
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
