// data/ai-quorum.db — the shadow experiment's OWN database (línea D).
// Deliberately separate from trading.db: this process never touches the
// bot's ledger, and the bot never reads this file. historical.db is opened
// elsewhere (snapshot.ts / book.ts) strictly read-only.

import { Database } from "bun:sqlite";
import type { AssetClass, ModelViews, QuorumPosition, Snapshot } from "./types";

export function openQuorumDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_class TEXT    NOT NULL,
      date_key    TEXT    NOT NULL,
      decided_at  INTEGER NOT NULL,
      -- "pending_keys" (snapshot stored, nobody called), "ok" (≥2 models
      -- answered), "partial" (1 answered — no quorum possible),
      -- "cost_capped" (daily USD cap reached), "failed" (0 answered).
      status      TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      UNIQUE (asset_class, date_key)
    );
    CREATE TABLE IF NOT EXISTS model_views (
      snapshot_id INTEGER NOT NULL,
      model_id    TEXT    NOT NULL,
      symbol      TEXT    NOT NULL,
      view        TEXT    NOT NULL,
      confidence  REAL    NOT NULL,
      PRIMARY KEY (snapshot_id, model_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS model_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      model_id    TEXT    NOT NULL,
      status      TEXT    NOT NULL,          -- ok | error
      latency_ms  INTEGER NOT NULL DEFAULT 0,
      cost_usd    REAL    NOT NULL DEFAULT 0,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      called_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quorum_positions (
      snapshot_id     INTEGER NOT NULL,
      symbol          TEXT    NOT NULL,
      direction       INTEGER NOT NULL,      -- +1 long, −1 short
      mean_confidence REAL    NOT NULL,
      PRIMARY KEY (snapshot_id, symbol)
    );
    -- One fill row per (snapshot, symbol) for EVERY snapshot symbol — the
    -- same two real bar opens price the book, each model's shadow book and
    -- both §12-D benchmarks. entry = open of the first daily bar AFTER the
    -- decision; exit = open of the following daily bar (one-day hold).
    CREATE TABLE IF NOT EXISTS fills (
      snapshot_id INTEGER NOT NULL,
      symbol      TEXT    NOT NULL,
      entry_ts    INTEGER,
      entry_px    REAL,
      exit_ts     INTEGER,
      exit_px     REAL,
      PRIMARY KEY (snapshot_id, symbol)
    );
  `);
  return db;
}

export interface SnapshotRow {
  id: number;
  asset_class: AssetClass;
  date_key: string;
  decided_at: number;
  status: string;
  payload: string;
}

export function getSnapshot(db: Database, assetClass: AssetClass, dateKey: string): SnapshotRow | null {
  return db.query<SnapshotRow, [string, string]>(
    "SELECT * FROM snapshots WHERE asset_class = ? AND date_key = ?",
  ).get(assetClass, dateKey) ?? null;
}

export function insertSnapshot(db: Database, snapshot: Snapshot, status: string): number {
  db.query(
    "INSERT INTO snapshots (asset_class, date_key, decided_at, status, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(snapshot.assetClass, snapshot.dateKey, snapshot.decidedAt, status, JSON.stringify(snapshot));
  const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
  return row.id;
}

export function setSnapshotStatus(db: Database, snapshotId: number, status: string): void {
  db.query("UPDATE snapshots SET status = ? WHERE id = ?").run(status, snapshotId);
}

export function insertModelViews(db: Database, snapshotId: number, modelId: string, views: ModelViews): void {
  const stmt = db.query(
    "INSERT OR REPLACE INTO model_views (snapshot_id, model_id, symbol, view, confidence) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [symbol, v] of Object.entries(views)) {
    stmt.run(snapshotId, modelId, symbol, v.view, v.confidence);
  }
}

export function insertModelCall(db: Database, row: {
  snapshotId: number; modelId: string; status: "ok" | "error";
  latencyMs?: number; costUsd?: number; tokensIn?: number; tokensOut?: number;
  error?: string; calledAt: number;
}): void {
  db.query(
    `INSERT INTO model_calls (snapshot_id, model_id, status, latency_ms, cost_usd, tokens_in, tokens_out, error, called_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.snapshotId, row.modelId, row.status, row.latencyMs ?? 0, row.costUsd ?? 0,
        row.tokensIn ?? 0, row.tokensOut ?? 0, row.error ?? null, row.calledAt);
}

export function insertQuorumPositions(db: Database, snapshotId: number, positions: QuorumPosition[]): void {
  const stmt = db.query(
    "INSERT OR REPLACE INTO quorum_positions (snapshot_id, symbol, direction, mean_confidence) VALUES (?, ?, ?, ?)",
  );
  for (const p of positions) stmt.run(snapshotId, p.symbol, p.direction, p.meanConfidence);
}

/** USD spent on model calls during the UTC day containing `now`. */
export function spentTodayUsd(db: Database, now: number): number {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const row = db.query<{ total: number | null }, [number, number]>(
    "SELECT SUM(cost_usd) AS total FROM model_calls WHERE called_at >= ? AND called_at < ?",
  ).get(dayStart.getTime(), dayStart.getTime() + 86_400_000);
  return row?.total ?? 0;
}
