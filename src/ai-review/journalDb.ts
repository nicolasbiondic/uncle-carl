// The two READ-ONLY lookups the effect ledger needs from the bot's databases: the journal's completed live passes (trading.db) and a
// session's daily open (historical.db). The callers open both with { readonly: true }; nothing here writes.
// Used by scripts/ai-review-report.ts (the ledger) and src/ai-review/history.ts (the case file's history): ONE reader for both.
// Enforced: scripts/ai-review-report.test.ts, src/ai-review/history.test.ts.

import type { Database } from "bun:sqlite";
import type { JournalPass, OpenLookup } from "./effects";

/** A journaled pass plus the symbols its book held when it ran (book_json, qty > 0). */
export interface HeldPass extends JournalPass { held: string[] }

/** The session's open from historical.db's daily bars (stamped inside the session's UTC day, Alpaca's 1d convention). */
export function dailyOpenLookup(hist: Database): OpenLookup {
  const q = hist.prepare(`SELECT open FROM historical_bars WHERE symbol = ? AND timeframe = '1d' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC LIMIT 1`);
  return (symbol, session) => {
    const from = Date.parse(`${session}T00:00:00Z`);
    const row = q.get(symbol, from, from + 86_400_000) as { open: number } | null;
    return row && Number.isFinite(row.open) && row.open > 0 ? row.open : null;
  };
}

function heldOf(bookJson: string | null): string[] {
  try {
    const book = JSON.parse(bookJson ?? "[]");
    if (!Array.isArray(book)) return [];
    return [...new Set(book.filter((p: any) => p && typeof p.symbol === "string" && Number.isFinite(p.qty) && p.qty > 0).map((p: any) => p.symbol as string))];
  } catch { return []; /* a malformed book reads as nothing held */ }
}

/** Every completed live pass of the stock sleeves, with only the review's own part of its diagnostics (the rest is large). */
export function readPasses(db: Database, since?: string): HeldPass[] {
  const has = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'portfolio_decisions'`).get();
  if (!has) return [];
  const rows = db.prepare(`SELECT account_id, session, status, equity, book_json, json_extract(diagnostics_json, '$.aiReview') AS ai
    FROM portfolio_decisions WHERE mode = 'live' AND status IN ('submitted', 'decided') AND account_id IN ('momentum_stocks', 'meanrev_stocks')
      AND session >= ? ORDER BY session, id`).all(since ?? "0000-00-00") as Array<{ account_id: string; session: string; status: string; equity: number; book_json: string | null; ai: string | null }>;
  return rows.map(r => {
    let aiReview: unknown = undefined;
    try { aiReview = r.ai ? JSON.parse(r.ai) : undefined; } catch { /* a malformed record reads as no review */ }
    return { sleeve: r.account_id, session: r.session, status: r.status, equity: r.equity, diagnostics: { aiReview }, held: heldOf(r.book_json) };
  });
}
