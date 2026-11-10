/**
 * SQLite propio del laboratorio (`data/memecoin-lab.db`, gitignored). Nada
 * de esto toca `data/trading.db`.
 *
 * Tablas:
 *   tokens         todo token cuyo CreateEvent vimos (agregados, para siempre)
 *   decisions      UNA decisión por candidato: entrada, o descarte con motivo
 *                  en el momento de mejor score (el contrafactual justo)
 *   outcomes       desenlace de TODA decisión: precio a +5 min / +1 h / +24 h,
 *                  graduó, rug
 *   orders         órdenes simuladas con su fill, costes y latencia real
 *   positions      operaciones (abiertas y cerradas) con P&L, costes y el gap del stop
 *   raw_trades     eventos crudos de los tokens candidatos (retención 7 días)
 *   equity         curva de equity (cada minuto)
 *   gaps           huecos del feed
 *   meta           clave/valor (versión, inicio, caudal, …)
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

export const DEFAULT_DB_PATH = join(import.meta.dir, "..", "..", "data", "memecoin-lab.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT, symbol TEXT, dev TEXT NOT NULL,
  created_at INTEGER NOT NULL, created_slot INTEGER NOT NULL,
  initial_v_sol INTEGER NOT NULL, initial_v_tok INTEGER NOT NULL, total_supply INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'tracking',
  trades_seen INTEGER NOT NULL DEFAULT 0, volume_sol REAL NOT NULL DEFAULT 0,
  holders INTEGER NOT NULL DEFAULT 0, last_price REAL NOT NULL DEFAULT 0, peak_price REAL NOT NULL DEFAULT 0,
  last_trade_at INTEGER, dev_sold INTEGER NOT NULL DEFAULT 0, migrated_at INTEGER, gapped INTEGER NOT NULL DEFAULT 0,
  dropped_at INTEGER
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL, decided_at INTEGER NOT NULL,
  entered INTEGER NOT NULL, reason TEXT NOT NULL, score REAL NOT NULL,
  metrics_json TEXT NOT NULL, price_sol REAL NOT NULL,
  strategy_version TEXT NOT NULL, config_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions(decided_at);
CREATE INDEX IF NOT EXISTS decisions_mint ON decisions(mint);
CREATE TABLE IF NOT EXISTS outcomes (
  decision_id INTEGER PRIMARY KEY, mint TEXT NOT NULL, decided_at INTEGER NOT NULL,
  price_0 REAL NOT NULL,
  price_5m REAL, price_1h REAL, price_24h REAL,
  ret_5m REAL, ret_1h REAL, ret_24h REAL,
  graduated INTEGER NOT NULL DEFAULT 0, rugged INTEGER NOT NULL DEFAULT 0,
  last_price REAL NOT NULL, last_price_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER, mint TEXT NOT NULL, side TEXT NOT NULL,
  decided_at INTEGER NOT NULL, execute_after INTEGER NOT NULL,
  status TEXT NOT NULL, filled_at INTEGER, ref_signature TEXT, latency_ms INTEGER,
  sol_amount REAL, tokens_raw INTEGER, price_sol REAL,
  pump_fee_sol REAL, mev_sol REAL, tx_fee_sol REAL, fee_bps INTEGER,
  reason TEXT NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS orders_pos ON orders(position_id);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL, decision_id INTEGER NOT NULL,
  opened_at INTEGER NOT NULL, closed_at INTEGER,
  tokens_raw INTEGER NOT NULL, tokens_remaining INTEGER NOT NULL,
  cost_sol REAL NOT NULL, proceeds_sol REAL NOT NULL DEFAULT 0, costs_sol REAL NOT NULL DEFAULT 0,
  entry_price REAL NOT NULL, exit_price REAL, entry_exec_pct REAL NOT NULL DEFAULT 0,
  pnl_sol REAL, pnl_pct REAL, peak_pct REAL NOT NULL DEFAULT 0,
  close_reason TEXT,
  stop_level_pct REAL, stop_trigger_pct REAL, stop_fill_pct REAL, stop_gap_pct REAL,
  gapped INTEGER NOT NULL DEFAULT 0,
  strategy_version TEXT NOT NULL, config_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_opened ON positions(opened_at);
CREATE TABLE IF NOT EXISTS raw_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL, slot INTEGER NOT NULL, signature TEXT NOT NULL,
  mint TEXT NOT NULL, user TEXT NOT NULL, is_buy INTEGER NOT NULL,
  sol_lamports INTEGER NOT NULL, token_raw INTEGER NOT NULL, v_sol INTEGER NOT NULL, v_tok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_trades_at ON raw_trades(received_at);
CREATE TABLE IF NOT EXISTS equity (
  at INTEGER PRIMARY KEY, cash_sol REAL NOT NULL, equity_sol REAL NOT NULL, open_positions INTEGER NOT NULL, sol_usd REAL
);
CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, from_at INTEGER NOT NULL, to_at INTEGER, reason TEXT NOT NULL);
`;

export function openLabDb(path: string = DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(SCHEMA);
  return db;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

/** Retención: eventos crudos más antiguos que `days` se borran; los agregados se quedan. */
export function pruneRawTrades(db: Database, now: number, days: number): number {
  const r = db.query("DELETE FROM raw_trades WHERE received_at < ?").run(now - days * 86_400_000);
  return r.changes;
}
