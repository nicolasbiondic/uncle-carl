// ═══ Candles route — /api/candles/:symbol ═══
//
// Returns OHLCV bars from HistoricalStore (historical.db) for the
// requested symbol + timeframe, plus open positions across all profiles
// and the last 20 closed trades for overlay rendering.
//
// TF mapping:
//   15m → store "15m"
//   30m → store "15m" grouped ×2
//   1h  → store "1h"
//   4h  → store "4h"
//   1d  → store "1d"
//   1w  → store "1d" grouped ×7
//
// Fallback for 15m/30m: if store returns [] use
//   getCachedCandles() (5Min in-memory cache)
//   3 raw 5m bars  → one 15m bar
//   6 raw 5m bars  → one 30m bar

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import { getBars } from "../../data/HistoricalStore";
import { getDB, RECONCILE_CLOSE_SQL } from "../../db/database";
import { toBoundedInt } from "../dashboard-utils";

// ── helpers ──────────────────────────────────────────────────────────────────

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function groupBars(bars: Bar[], groupSize: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const slice = bars.slice(i, i + groupSize);
    if (!slice.length) continue;
    out.push({
      t: slice[0].t,
      o: slice[0].o,
      h: Math.max(...slice.map(b => b.h)),
      l: Math.min(...slice.map(b => b.l)),
      c: slice[slice.length - 1].c,
      v: slice.reduce((s, b) => s + (b.v || 0), 0),
    });
  }
  return out;
}

function ohlcvToBar(c: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }): Bar {
  return { t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
}

// route tf → Alpaca timeframe + grouping, for the on-demand live fallback.
// Alpaca's REST supports 15Min/1Hour/1Day; 30m/4h/1w are grouped up from those.
const TF_LIVE: Record<string, { atf: string; group: number }> = {
  "15m": { atf: "15Min", group: 1 },
  "30m": { atf: "15Min", group: 2 },
  "1h":  { atf: "1Hour", group: 1 },
  "4h":  { atf: "1Hour", group: 4 },
  "1d":  { atf: "1Day",  group: 1 },
  "1w":  { atf: "1Day",  group: 7 },
};

// ── registration ─────────────────────────────────────────────────────────────

export function registerCandlesRoutes(app: express.Application, am: AccountManager): void {
  // GET /api/candles/:symbol
  // Query params:
  //   tf    — timeframe token: 15m | 30m | 1h | 4h | 1d | 1w  (default 1h)
  //   limit — max bars to return, 1–500 (default 200)
  //   from  — epoch ms lower bound (default: now - 90 days)
  app.get("/api/candles/:symbol", async (req, res) => {
    try {
      let symbol: string;
      try { symbol = decodeURIComponent(req.params.symbol); }
      catch { res.status(400).json({ error: "Invalid symbol encoding" }); return; }
      const tf      = (req.query.tf as string) || "1h";
      const limit   = toBoundedInt(req.query.limit, 200, 1, 500);
      const now     = Date.now();
      const defaultFrom = now - 90 * 24 * 3600_000;
      const fromMs = req.query.from
        ? Math.max(0, Math.min(now, parseInt(String(req.query.from), 10) || defaultFrom))
        : defaultFrom;

      // ── 1. Fetch raw bars from HistoricalStore ──────────────────────────
      let bars: Bar[] = [];

      if (tf === "15m" || tf === "30m") {
        const raw = getBars(symbol, "15m", fromMs, now).map(ohlcvToBar);
        if (raw.length > 0) {
          bars = tf === "30m" ? groupBars(raw, 2) : raw;
        } else {
          // Fallback: use 5Min in-memory Alpaca cache
          const cached = am.executor.alpaca.getCachedCandles(symbol).map(ohlcvToBar);
          bars = tf === "30m" ? groupBars(cached, 6) : groupBars(cached, 3);
        }
      } else if (tf === "1h") {
        bars = getBars(symbol, "1h", fromMs, now).map(ohlcvToBar);
      } else if (tf === "4h") {
        bars = getBars(symbol, "4h", fromMs, now).map(ohlcvToBar);
      } else if (tf === "1d") {
        bars = getBars(symbol, "1d", fromMs, now).map(ohlcvToBar);
      } else if (tf === "1w") {
        const daily = getBars(symbol, "1d", fromMs, now).map(ohlcvToBar);
        bars = groupBars(daily, 7);
      } else {
        return res.status(400).json({ error: "Unknown timeframe. Valid: 15m 30m 1h 4h 1d 1w" });
      }

      // ── 1b. Live fallback ───────────────────────────────────────────────
      // HistoricalStore is only backtest-fetched and the 5Min cache is only
      // warm for symbols the live loop scanned at 5Min. The momentum stock
      // sleeve fetches daily/hourly, so a live stock like JPM has NEITHER
      // source at these TFs → "No candle data". Fetch real bars from Alpaca on
      // demand (12s-bounded); getBars caches them, so repeat opens are instant.
      if (bars.length === 0) {
        const live = TF_LIVE[tf];
        if (live && am.executor?.alpaca) {
          const raw = (await am.executor.alpaca.getBars(symbol, live.atf, limit * live.group)).map(ohlcvToBar);
          bars = live.group > 1 ? groupBars(raw, live.group) : raw;
        }
      }

      // ── 2. Trim to last `limit` bars ────────────────────────────────────
      if (bars.length > limit) {
        bars = bars.slice(bars.length - limit);
      }

      // ── 3. Collect open positions for this symbol across all profiles ───
      const openPositions: Array<{
        profileId: string;
        side: string;
        quantity: number;
        avgEntryPrice: number;
        currentPrice: number;
        unrealizedPnl: number;
        unrealizedPnlPct: number;
        stopLoss?: number;
        takeProfit?: number;
        openedAt: number;
      }> = [];

      for (const [profileId, acc] of am.accounts) {
        const pos = acc.positions.get(symbol);
        if (pos) {
          openPositions.push({
            profileId,
            side: pos.side,
            quantity: pos.quantity,
            avgEntryPrice: pos.avgEntryPrice,
            currentPrice: pos.currentPrice,
            unrealizedPnl: pos.unrealizedPnl,
            unrealizedPnlPct: pos.unrealizedPnlPct,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            openedAt: pos.openedAt,
          });
        }
      }

      // ── 4. Last 20 closed trades for this symbol ─────────────────────────
      const closedRows = getDB()
        .prepare(
          `SELECT id, account_id, side, strategy, entry_price, exit_price,
                  quantity, pnl, pnl_pct, entry_time, exit_time, close_reason
             FROM trades
            WHERE symbol = ? AND status = 'closed'
              AND exit_time IS NOT NULL
              AND ${RECONCILE_CLOSE_SQL}
              AND account_id NOT LIKE 'shadow_%'
            ORDER BY exit_time DESC
            LIMIT 20`
        )
        .all(symbol) as Array<{
          id: string;
          account_id: string;
          side: string;
          strategy: string;
          entry_price: number;
          exit_price: number | null;
          quantity: number;
          pnl: number | null;
          pnl_pct: number | null;
          entry_time: number;
          exit_time: number | null;
          close_reason: string | null;
        }>;

      const closedTrades = closedRows.map(r => ({
        id: r.id,
        accountId: r.account_id,
        side: r.side,
        strategy: r.strategy,
        entryPrice: r.entry_price,
        exitPrice: r.exit_price,
        quantity: r.quantity,
        pnl: r.pnl,
        pnlPct: r.pnl_pct,
        entryTime: r.entry_time,
        exitTime: r.exit_time,
        closeReason: r.close_reason,
      }));

      // ── 5. Respond ───────────────────────────────────────────────────────
      res.json({
        symbol,
        tf,
        bars,
        openPositions,
        closedTrades,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
