/** Public data only. Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/
 * userFillsByTime exposes only the latest 10,000 fills, NOT lifetime history.
 * A realized-PnL curve is NOT equity: deposits, funding and open PnL are absent.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { researchDataPath } from "./researchData";

export interface Fill {
  coin: string; time: number; tid: number; hash: string; oid: number;
  closedPnl: string; fee: string; feeToken: string; px: string; sz: string;
  side: string; startPosition: string;
}
export interface Leader {
  ethAddress: string; accountValue: string;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}
export interface State {
  time: number; marginSummary: { accountValue: string };
  assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
}
export type Portfolio = [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][] }][];
export const COINS = "BTC ETH SOL XRP DOGE ADA AVAX BCH BNB LINK LTC NEAR UNI".split(" ");
export const LIMITS = {
  candidates: "Only addresses ever observed in a stored leaderboard; absent/delisted/failed traders are missing. Strict mode additionally requires first_seen < t.",
  history: "Latest 10000 fills only; lifetime completeness cannot be certified, even below the cap. Forward gaps can exceed retention.",
  equity: "Uses only USDC-fee perpetual fills: closedPnl minus fees is a realized PnL proxy, not equity or total return; excludes funding, transfers, unrealized PnL and all non-USDC-fee/spot fills. Actual equity is only observed accountValue.",
};

export function openHyperliquid(path = researchDataPath("hyperliquid.db")): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS hl_cache(key TEXT PRIMARY KEY, observed_ms INTEGER, json TEXT);
    CREATE TABLE IF NOT EXISTS hl_rate(time_ms INTEGER, weight INTEGER);
    CREATE TABLE IF NOT EXISTS hl_addresses(address TEXT PRIMARY KEY, first_seen_ms INTEGER);
    CREATE TABLE IF NOT EXISTS hl_leaderboard(snapshot_ms INTEGER, address TEXT, account_value REAL, windows_json TEXT, PRIMARY KEY(snapshot_ms,address));
    CREATE INDEX IF NOT EXISTS hl_leaderboard_address ON hl_leaderboard(address,snapshot_ms);
    CREATE TABLE IF NOT EXISTS hl_states(snapshot_ms INTEGER, address TEXT, observed_ms INTEGER, json TEXT, PRIMARY KEY(snapshot_ms,address));
    CREATE TABLE IF NOT EXISTS hl_portfolios(address TEXT, observed_ms INTEGER, json TEXT, PRIMARY KEY(address,observed_ms));
    CREATE TABLE IF NOT EXISTS hl_fills(address TEXT, fill_key TEXT, time_ms INTEGER, known_ms INTEGER, coin TEXT, closed_pnl REAL, fee REAL, fee_token TEXT, json TEXT, PRIMARY KEY(address,fill_key));
    CREATE INDEX IF NOT EXISTS hl_fills_time ON hl_fills(address,time_ms);
    CREATE TABLE IF NOT EXISTS hl_history(address TEXT PRIMARY KEY, checked_ms INTEGER, through_ms INTEGER, count INTEGER, retention_limit INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS hl_selections(snapshot_ms INTEGER PRIMARY KEY, known_ms INTEGER, addresses_json TEXT, config_json TEXT);
  `);
  return db;
}

export class HyperliquidClient {
  constructor(readonly db: Database, readonly http: typeof fetch = fetch,
    readonly now: () => number = Date.now,
    readonly sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms)) {}

  private async reserve(weight: number): Promise<void> {
    // Shared SQLite reservation across processes: <=1000/rolling minute, below
    // documented IP limit 1200. Reserve worst-case 121 for 2000-fill responses
    // (20 base + ceil(items/20) + one safety unit). Other IP users need headroom.
    for (;;) {
      const wait = this.db.transaction(() => {
        const now = this.now();
        this.db.run("DELETE FROM hl_rate WHERE time_ms <= ?", [now - 60000]);
        const row = this.db.query<{ total: number; oldest: number | null }, []>("SELECT coalesce(sum(weight),0) total,min(time_ms) oldest FROM hl_rate").get()!;
        if (row.total + weight > 1000) return Math.max(1, row.oldest! + 60001 - now);
        this.db.run("INSERT INTO hl_rate VALUES (?,?)", [now, weight]);
        return 0;
      }).immediate();
      if (!wait) return;
      await this.sleep(wait);
    }
  }

  async request<T>(body: Record<string, unknown> | null, ttlMs = 0): Promise<{ data: T; observedMs: number }> {
    const key = JSON.stringify(body);
    const cached = this.db.query<{ json: string; observed_ms: number }, [string]>("SELECT * FROM hl_cache WHERE key=?").get(key);
    if (cached && this.now() - cached.observed_ms < ttlMs) return { data: JSON.parse(cached.json), observedMs: cached.observed_ms };
    const type = body?.type;
    const weight = type === "clearinghouseState" ? 2 : type === "userFills" || type === "userFillsByTime" ? 121 : 20;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.reserve(weight);
      const response = await this.http(body ? "https://api.hyperliquid.xyz/info" : "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get("retry-after");
        const retryMs = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - this.now()) : 0;
        await response.body?.cancel();
        await this.sleep(Math.max(1000 * 2 ** attempt, retryMs || 0));
        continue;
      }
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}: ${await response.text()}`);
      const data = await response.json() as T;
      const observedMs = this.now();
      this.db.run("INSERT OR REPLACE INTO hl_cache VALUES (?,?,?)", [key, observedMs, JSON.stringify(data)]);
      return { data, observedMs };
    }
    throw new Error("Hyperliquid retry budget exhausted");
  }
  leaderboard() { return this.request<{ leaderboardRows: Leader[] }>(null); }
  clearinghouseState(user: string) { return this.request<State>({ type: "clearinghouseState", user }); }
  userFills(user: string) { return this.request<Fill[]>({ type: "userFills", user, aggregateByTime: false }, 60000); }
  userFillsByTime(user: string, startTime: number, endTime: number) {
    return this.request<Fill[]>({ type: "userFillsByTime", user, startTime, endTime, aggregateByTime: false });
  }
  portfolio(user: string) { return this.request<Portfolio>({ type: "portfolio", user }, 60000); }
  meta() { return this.request<{ universe: { name: string }[] }>({ type: "meta" }, 3600000); }
}

export function storeLeaderboard(db: Database, rows: Leader[], time: number): void {
  db.transaction(() => {
    for (const row of rows) {
      const address = row.ethAddress.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isFinite(Number(row.accountValue))) throw new Error("Invalid leaderboard row");
      db.run("INSERT OR IGNORE INTO hl_addresses VALUES (?,?)", [address, time]);
      db.run("INSERT OR IGNORE INTO hl_leaderboard VALUES (?,?,?,?)", [time, address, Number(row.accountValue), JSON.stringify(row.windowPerformances)]);
    }
  })();
}

/** Inclusive boundary pagination: retain last timestamp, deduplicate. A whole
 * 2000-fill millisecond cannot be paginated safely: fail rather than skip it. */
export async function collectHistory(client: HyperliquidClient, address: string): Promise<number> {
  const db = client.db;
  if (!db.query("SELECT 1 FROM hl_addresses WHERE address=?").get(address)) throw new Error("Address outside stored candidate universe");
  const previous = db.query<{ through_ms: number }, [string]>("SELECT through_ms FROM hl_history WHERE address=? AND error IS NULL").get(address);
  let cursor = previous ? Math.max(0, previous.through_ms - 1) : 0;
  const end = client.now();
  let retained = 0;
  try {
    for (;;) {
      const { data, observedMs } = await client.userFillsByTime(address, cursor, end);
      if (!Array.isArray(data)) throw new Error("Invalid fills response");
      data.sort((a, b) => a.time - b.time || a.tid - b.tid);
      db.transaction(() => {
        for (const f of data) {
          if (f.time < cursor || f.time > end || ![f.time, Number(f.closedPnl), Number(f.fee)].every(Number.isFinite)) throw new Error("Invalid fill");
          db.run("INSERT OR IGNORE INTO hl_fills VALUES (?,?,?,?,?,?,?,?,?)", [address, `${f.coin}:${f.tid}:${f.oid}:${f.hash}`, f.time, observedMs, f.coin, Number(f.closedPnl), Number(f.fee), f.feeToken.trim(), JSON.stringify(f)]);
        }
      })();
      retained += data.length;
      if (!data.length) break;
      const last = data[data.length - 1]!.time;
      if (last === cursor) {
        if (data.length >= 2000) throw new Error("Unpageable 2000-fill timestamp; history incomplete");
        cursor = last + 1;
      } else cursor = last;
      if (cursor > end) break;
    }
    const count = db.query<{ n: number }, [string]>("SELECT count(*) n FROM hl_fills WHERE address=?").get(address)!.n;
    db.run("INSERT OR REPLACE INTO hl_history VALUES (?,?,?,?,?,NULL)", [address, client.now(), end, count, count >= 10000 ? 1 : 0]);
    return count;
  } catch (error) {
    db.run("INSERT OR REPLACE INTO hl_history VALUES (?,?,?,?,?,?)", [address, client.now(), previous?.through_ms ?? 0, retained, 1, String(error)]);
    throw error;
  }
}
