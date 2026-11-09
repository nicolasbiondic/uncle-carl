// Vega phase R data layer: everything that touches SQLite for the options research, kept out of the
// pure kernel (scripts/lib/optionsWeekly.ts). Sources:
//   hist-options.db   mirror tables written by scripts/options-mirror-to-sqlite.py and the alpaca_*
//                     tables written by scripts/download-alpaca-option-bars.ts
//   data/historical.db  SPY/QQQ adjusted daily closes after the mirror (historical_bars, 1d, alpaca_wide)
import { Database } from "bun:sqlite";
import { expandDataPath } from "./researchData";
import type { OptionType, Quote, Session } from "./optionsWeekly";

export const UNDERLYINGS = ["SPY", "QQQ"] as const;

export interface UnderlyingRow { date: Session; close: number; adjusted_close: number; dividend_amount: number }

export function openOptionsDb(path = "$UC_RESEARCH_DATA_DIR/hist-options.db", readonly = true): Database {
  const db = new Database(expandDataPath(path), readonly ? { readonly: true } : { create: true });
  if (!readonly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alpaca_underlying_daily (symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL, PRIMARY KEY (symbol, date));
      CREATE TABLE IF NOT EXISTS alpaca_dividends (symbol TEXT NOT NULL, ex_date TEXT NOT NULL, rate REAL NOT NULL, PRIMARY KEY (symbol, ex_date));
      CREATE TABLE IF NOT EXISTS alpaca_listed (underlying TEXT NOT NULL, date TEXT NOT NULL, expiration TEXT NOT NULL, PRIMARY KEY (underlying, date, expiration));
      CREATE TABLE IF NOT EXISTS alpaca_contracts (symbol TEXT PRIMARY KEY, underlying TEXT NOT NULL, expiration TEXT NOT NULL, type TEXT NOT NULL, strike REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_alpaca_contracts_ue ON alpaca_contracts(underlying, expiration);
      CREATE TABLE IF NOT EXISTS alpaca_option_bars (symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL, trade_count REAL, vwap REAL, PRIMARY KEY (symbol, date));
      CREATE TABLE IF NOT EXISTS alpaca_weeks (underlying TEXT NOT NULL, entry TEXT NOT NULL, expiration TEXT, exit TEXT, status TEXT NOT NULL, contracts INTEGER, bars INTEGER, note TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (underlying, entry));
    `);
  }
  return db;
}

export function mirrorUnderlying(db: Database, symbol: string): UnderlyingRow[] {
  return db.query<UnderlyingRow, [string]>("SELECT date, close, adjusted_close, dividend_amount FROM underlying_daily WHERE symbol = ? ORDER BY date").all(symbol);
}

export function mirrorLastOptionsDate(db: Database, underlying: string): string {
  return db.query<{ d: string }, [string]>("SELECT max(date) d FROM mirror_listed WHERE underlying = ?").get(underlying)!.d;
}

export function mirrorListed(db: Database, underlying: string, date: Session): string[] {
  return db.query<{ expiration: string }, [string, string]>("SELECT expiration FROM mirror_listed WHERE underlying = ? AND date = ? ORDER BY expiration").all(underlying, date).map(r => r.expiration);
}

export function mirrorChain(db: Database, underlying: string, date: Session, expiration: string): Quote[] {
  return db.query<{ type: OptionType; strike: number; bid: number | null; ask: number | null }, [string, string, string]>(
    "SELECT type, strike, bid, ask FROM mirror_options WHERE underlying = ? AND date = ? AND expiration = ? ORDER BY type, strike").all(underlying, date, expiration);
}

/** Adjusted daily closes of a symbol from data/historical.db (alpaca_wide, 1d), by session. */
export function historicalAdjustedCloses(historicalDbPath: string, symbol: string): Map<Session, number> {
  const db = new Database(historicalDbPath, { readonly: true });
  try {
    const rows = db.query<{ ts: number; close: number }, [string]>(
      "SELECT timestamp ts, close FROM historical_bars WHERE symbol = ? AND timeframe = '1d' AND source = 'alpaca_wide' ORDER BY timestamp").all(symbol);
    const out = new Map<Session, number>();
    for (const r of rows) out.set(new Date(r.ts).toISOString().slice(0, 10), r.close);
    return out;
  } finally { db.close(); }
}

export function alpacaRawCloses(db: Database, symbol: string): Map<Session, number> {
  const out = new Map<Session, number>();
  for (const r of db.query<{ date: string; close: number }, [string]>("SELECT date, close FROM alpaca_underlying_daily WHERE symbol = ? ORDER BY date").all(symbol)) out.set(r.date, r.close);
  return out;
}

export function alpacaListed(db: Database, underlying: string, date: Session): string[] {
  return db.query<{ expiration: string }, [string, string]>("SELECT expiration FROM alpaca_listed WHERE underlying = ? AND date = ? ORDER BY expiration").all(underlying, date).map(r => r.expiration);
}

export interface AlpacaBarQuote { type: OptionType; strike: number; close: number }

/** Bar closes of every downloaded contract of (underlying, expiration) on `date`. */
export function alpacaChainCloses(db: Database, underlying: string, date: Session, expiration: string): AlpacaBarQuote[] {
  return db.query<AlpacaBarQuote, [string, string, string]>(
    `SELECT c.type type, c.strike strike, b.close close FROM alpaca_contracts c JOIN alpaca_option_bars b ON b.symbol = c.symbol
     WHERE c.underlying = ? AND c.expiration = ? AND b.date = ? ORDER BY c.type, c.strike`).all(underlying, expiration, date);
}

export function alpacaDividends(db: Database, symbol: string): Map<Session, number> {
  const out = new Map<Session, number>();
  for (const r of db.query<{ ex_date: string; rate: number }, [string]>("SELECT ex_date, rate FROM alpaca_dividends WHERE symbol = ?").all(symbol)) out.set(r.ex_date, r.rate);
  return out;
}

/**
 * The research session list: the mirror's SPY dates, then historical.db's SPY sessions after the
 * mirror's last underlying date (the manifest: "las fechas presentes en los cierres diarios de SPY").
 */
export function buildSessions(mirrorSpy: readonly UnderlyingRow[], historicalSpy: Map<Session, number>): Session[] {
  const last = mirrorSpy[mirrorSpy.length - 1].date;
  const out = mirrorSpy.map(r => r.date);
  for (const d of [...historicalSpy.keys()].sort()) if (d > last) out.push(d);
  return out;
}

/**
 * Adjusted closes: the mirror's adjusted_close through its last date, then historical.db chained by
 * ratio from that date (total-return consistent across the splice whatever the two as-of dates).
 */
export function spliceAdjusted(mirror: readonly UnderlyingRow[], historical: Map<Session, number>): Map<Session, number> {
  const out = new Map<Session, number>();
  for (const r of mirror) out.set(r.date, r.adjusted_close);
  const last = mirror[mirror.length - 1];
  const anchor = historical.get(last.date);
  if (anchor === undefined) return out;
  const k = last.adjusted_close / anchor;
  for (const [d, c] of historical) if (d > last.date) out.set(d, c * k);
  return out;
}

/** Fingerprint of the second-provider tables, for the artifact identity. */
export function alpacaTablesHash(db: Database): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const r of db.query<{ symbol: string; date: string; close: number }, []>("SELECT symbol, date, close FROM alpaca_option_bars ORDER BY symbol, date").all()) h.update(`${r.symbol}|${r.date}|${r.close}\n`);
  for (const r of db.query<{ symbol: string; date: string; close: number }, []>("SELECT symbol, date, close FROM alpaca_underlying_daily ORDER BY symbol, date").all()) h.update(`${r.symbol}|${r.date}|${r.close}\n`);
  for (const r of db.query<{ underlying: string; date: string; expiration: string }, []>("SELECT underlying, date, expiration FROM alpaca_listed ORDER BY 1, 2, 3").all()) h.update(`${r.underlying}|${r.date}|${r.expiration}\n`);
  return h.digest("hex");
}
