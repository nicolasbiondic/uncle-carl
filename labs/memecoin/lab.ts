/**
 * Orquestador del laboratorio: eventos decodificados → estado por token →
 * decisiones (entrada o descarte con motivo) → órdenes simuladas con
 * latencia → posiciones → desenlaces. Determinista: todo instante entra por
 * parámetro (`receivedAt`, `now`); no lee el reloj. main.ts lo alimenta con
 * el feed real y tape.ts con cintas sintéticas en los tests.
 *
 * Ciclo de una orden: decidida en t → `executeAfter = t + latencyMs` → se
 * llena contra el estado de la curva del PRIMER trade observado del token con
 * receivedAt ≥ executeAfter. Compra sin trade en `buyFillTimeoutMs` → se
 * cancela (no hay liquidez observada, no se inventa). Venta sin trade en
 * `sellDeadTimeoutMs` → se llena contra el último estado real (token
 * muerto; un rug se paga entero).
 */
import type { Database } from "bun:sqlite";
import { configHash, LAB_CONFIG, STRATEGY_VERSION, type LabConfig } from "./config";
import { LAMPORTS_PER_SOL, type CurveState } from "./curve";
import { SignatureDeduper, type CompleteEvent, type CreateEvent, type Notification, type TradeEvent } from "./decoder";
import { executablePnlPct, simulateBuy, simulateSell } from "./sim";
import { evaluateCandidate, evaluateExit, evaluatePortfolio, reasonRank, type DiscardReason, type ExitReason, type Verdict } from "./strategy";
import { TokenState, type TokenMetrics } from "./tracker";

export interface LabLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const silentLog: LabLogger = { info() {}, warn() {}, error() {} };

interface PendingOrder {
  id: number;
  mint: string;
  side: "buy" | "sell";
  decidedAt: number;
  executeAfter: number;
  timeoutAt: number;
  reason: string;
  /** Compra: presupuesto en SOL. */
  sizeSol?: number;
  /** Venta: tokens a vender. */
  tokensRaw?: number;
  positionId?: number;
  takeProfitIndex?: number;
  /** Stop: P&L ejecutable que disparó la orden (para medir el gap). */
  triggerPct?: number;
}

export interface Position {
  id: number;
  mint: string;
  dev: string;
  decisionId: number;
  openedAt: number;
  tokensRaw: number;
  tokensRemaining: number;
  costSol: number;
  proceedsSol: number;
  costsSol: number;
  entryPrice: number;
  /** P&L ejecutable justo tras el fill (referencia del stop). */
  entryExecPct: number;
  peakPct: number;
  takeProfitDone: number[];
  devSold: boolean;
  migrated: boolean;
  gapped: boolean;
  sellPending: boolean;
}

interface OutcomeWatch {
  decisionId: number;
  mint: string;
  decidedAt: number;
  price0: number;
  lastPrice: number;
  lastPriceAt: number;
  filled: boolean[];
  graduated: boolean;
}

interface BestEval {
  at: number;
  verdict: Verdict;
  metrics: TokenMetrics;
  price: number;
}

interface TokenMeta {
  lastEvalAt: number;
  best: BestEval | null;
  decided: boolean;
  rawStored: boolean;
  /** Rastro de precios (≤ 1 muestra/s) para valorar horizontes ya vencidos cuando la decisión se registra a posteriori. */
  trail: [number, number][];
}

export interface LabStats {
  creates: number;
  trades: number;
  tradesTracked: number;
  completes: number;
  duplicates: number;
  decisions: number;
  entries: number;
  gaps: number;
  /** Tokens desalojados por el tope `maxTrackedTokens` (ventana cerrada antes de tiempo). */
  evicted: number;
}

export class MemecoinLab {
  readonly cfg: LabConfig;
  readonly version = STRATEGY_VERSION;
  readonly hash: string;
  readonly tokens = new Map<string, TokenState>();
  readonly positions = new Map<string, Position>();
  readonly pending: PendingOrder[] = [];
  readonly stats: LabStats = { creates: 0, trades: 0, tradesTracked: 0, completes: 0, duplicates: 0, decisions: 0, entries: 0, gaps: 0, evicted: 0 };
  cashSol: number;
  private readonly meta = new Map<string, TokenMeta>();
  private readonly watches = new Map<string, OutcomeWatch[]>();
  /** Último estado de curva por mint vigilado (desenlaces y posiciones restauradas tras un reinicio). */
  private readonly lastCurve = new Map<string, { curve: CurveState; feeBps: number | null; at: number }>();
  private readonly traded: SignatureDeduper;
  private readonly dedupe: SignatureDeduper;
  private readonly rawBuffer: unknown[][] = [];
  private watchCount = 0;
  /** Filas crudas descartadas por buffer lleno (nunca se acumulan). */
  rawDropped = 0;
  private nextOrderId = 1;
  private readonly log: LabLogger;
  private openGapId: number | null = null;

  constructor(private readonly db: Database, opts: { cfg?: LabConfig; log?: LabLogger; now: number }) {
    this.cfg = opts.cfg ?? LAB_CONFIG;
    this.hash = configHash(this.cfg);
    this.log = opts.log ?? silentLog;
    this.traded = new SignatureDeduper(this.cfg.limits.maxTradedMints);
    this.dedupe = new SignatureDeduper(this.cfg.limits.maxDedupeSignatures);
    this.cashSol = this.restore(opts.now);
  }

  // ── restauración tras reinicio ───────────
  private restore(now: number): number {
    const cashRow = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'cash_sol'").get();
    const cash = cashRow ? Number(cashRow.value) : this.cfg.account.initialSol;
    if (!cashRow) {
      this.db.query("INSERT INTO meta(key, value) VALUES ('cash_sol', ?)").run(String(cash));
      this.db.query("INSERT INTO meta(key, value) VALUES ('started_at', ?) ON CONFLICT(key) DO NOTHING").run(String(now));
    }
    this.db.query("INSERT INTO meta(key, value) VALUES ('strategy_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.version);
    this.db.query("INSERT INTO meta(key, value) VALUES ('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.hash);
    for (const r of this.db.query<{ mint: string }, [number]>("SELECT DISTINCT mint FROM positions ORDER BY id DESC LIMIT ?").all(this.cfg.limits.maxTradedMints)) this.traded.admit(r.mint);
    const open = this.db
      .query<any, []>("SELECT p.*, t.dev AS dev FROM positions p LEFT JOIN tokens t ON t.mint = p.mint WHERE p.closed_at IS NULL")
      .all();
    for (const r of open) {
      this.positions.set(r.mint, {
        id: r.id,
        mint: r.mint,
        dev: r.dev ?? "",
        decisionId: r.decision_id,
        openedAt: r.opened_at,
        tokensRaw: r.tokens_raw,
        tokensRemaining: r.tokens_remaining,
        costSol: r.cost_sol,
        proceedsSol: r.proceeds_sol,
        costsSol: r.costs_sol,
        entryPrice: r.entry_price,
        entryExecPct: r.entry_exec_pct,
        peakPct: r.peak_pct,
        takeProfitDone: [],
        devSold: false,
        migrated: false,
        gapped: true, // tras un reinicio no sabemos qué pasó: la operación queda marcada
        sellPending: false,
      });
      this.log.warn(`posición restaurada tras reinicio ${r.mint} (marcada gapped)`);
    }
    const pendingOutcomes = this.db.query<any, [number]>("SELECT * FROM outcomes WHERE done = 0 ORDER BY decided_at DESC LIMIT ?").all(this.cfg.limits.maxOutcomeWatches);
    for (const o of pendingOutcomes) {
      this.watchCount++;
      const w: OutcomeWatch = {
        decisionId: o.decision_id,
        mint: o.mint,
        decidedAt: o.decided_at,
        price0: o.price_0,
        lastPrice: o.last_price,
        lastPriceAt: o.last_price_at,
        filled: [o.price_5m !== null, o.price_1h !== null, o.price_24h !== null],
        graduated: o.graduated === 1,
      };
      const list = this.watches.get(o.mint) ?? [];
      list.push(w);
      this.watches.set(o.mint, list);
    }
    const maxOrder = this.db.query<{ m: number | null }, []>("SELECT MAX(id) AS m FROM orders").get();
    this.nextOrderId = (maxOrder?.m ?? 0) + 1;
    return cash;
  }

  // ── entrada de eventos ───────────────────
  onNotification(n: Notification, receivedAt: number): void {
    if (!this.dedupe.admit(n.signature)) {
      this.stats.duplicates++;
      return;
    }
    for (const ev of n.events) {
      if (ev.type === "trade") this.onTrade(ev, receivedAt, n.signature, n.slot);
      else if (ev.type === "create") this.onCreate(ev, receivedAt, n.slot);
      else this.onComplete(ev, receivedAt);
    }
  }

  private onCreate(ev: CreateEvent, receivedAt: number, slot: number): void {
    this.stats.creates++;
    if (this.tokens.has(ev.mint)) return;
    // Tope de tokens vigilados: desaloja el más antiguo sin posición ni orden (orden de inserción del Map = creación).
    while (this.tokens.size >= this.cfg.limits.maxTrackedTokens) {
      let victim: string | null = null;
      for (const mint of this.tokens.keys()) {
        if (!this.positions.has(mint) && !this.pending.some((o) => o.mint === mint)) {
          victim = mint;
          break;
        }
      }
      if (victim === null) break;
      this.stats.evicted++;
      this.dropToken(victim, receivedAt);
    }
    const s = this.cfg.strategy;
    const t = new TokenState(ev, receivedAt, slot, {
      tradeHistoryMs: this.cfg.tracking.tradeHistoryMs,
      earlyWindowMs: s.filters.earlyWindowMs,
      entryWindowMs: s.entry.windowMs,
      reversalWindowMs: s.exits.reversalWindowMs,
      maxWallets: this.cfg.limits.maxWalletsPerToken,
      maxTrades: this.cfg.limits.maxTradesPerToken,
    });
    this.tokens.set(ev.mint, t);
    this.meta.set(ev.mint, { lastEvalAt: 0, best: null, decided: false, rawStored: false, trail: [] });
    this.db
      .query(
        "INSERT OR IGNORE INTO tokens(mint, name, symbol, dev, created_at, created_slot, initial_v_sol, initial_v_tok, total_supply, peak_price, last_price) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(ev.mint, ev.name.slice(0, 64), ev.symbol.slice(0, 32), ev.creator, receivedAt, slot, ev.vSol, ev.vTok, ev.totalSupply, t.price, t.price);
  }

  private onTrade(ev: TradeEvent, receivedAt: number, signature: string, slot: number): void {
    this.stats.trades++;
    const token = this.tokens.get(ev.mint);
    const pos = this.positions.get(ev.mint);
    const watched = this.watches.get(ev.mint);
    if (!token && !pos && !watched) return; // token anterior al arranque: descarte barato
    this.stats.tradesTracked++;
    const curve = { vSol: ev.vSol, vTok: ev.vTok };
    this.lastCurve.set(ev.mint, { curve, feeBps: ev.feeBps, at: receivedAt });
    if (token) {
      token.onTrade(ev, receivedAt, signature);
      if (this.meta.get(ev.mint)?.rawStored) this.pushRaw([receivedAt, slot, signature, ev.mint, ev.user, ev.isBuy ? 1 : 0, ev.solLamports, ev.tokenRaw, ev.vSol, ev.vTok]);
    }
    if (pos && !ev.isBuy && ev.user === pos.dev && ev.tokenRaw > 0) pos.devSold = true;
    const price = curve.vTok > 0 ? curve.vSol / LAMPORTS_PER_SOL / (curve.vTok / 1_000_000) : 0;
    if (watched) for (const w of watched) if (!w.graduated) { w.lastPrice = price; w.lastPriceAt = receivedAt; }
    this.fillPending(ev.mint, receivedAt, curve, ev.feeBps, signature);
    const posAfter = this.positions.get(ev.mint);
    if (posAfter) this.manageExit(posAfter, receivedAt, curve, ev.feeBps, token);
    else if (token) this.maybeEvaluate(token, receivedAt);
  }

  private onComplete(ev: CompleteEvent, receivedAt: number): void {
    this.stats.completes++;
    const token = this.tokens.get(ev.mint);
    if (token) {
      token.markMigrated(receivedAt);
      this.db.query("UPDATE tokens SET status = 'migrated', migrated_at = ? WHERE mint = ?").run(receivedAt, ev.mint);
    }
    const watched = this.watches.get(ev.mint);
    if (watched) for (const w of watched) w.graduated = true;
    const pos = this.positions.get(ev.mint);
    if (pos) {
      pos.migrated = true;
      // Salida forzada: último estado de curva menos el recargo declarado. Se liquida ya (no habrá más trades de curva).
      const last = this.lastCurve.get(ev.mint);
      if (last) {
        this.cancelPendingFor(ev.mint, "migration");
        this.executeSell(pos, pos.tokensRemaining, receivedAt, last.curve, last.feeBps, "migration", null, { penalty: this.cfg.sim.migrationExitPenalty, note: "forced_exit_after_migration", decidedAt: receivedAt });
      }
    }
  }

  /** Hueco del feed: desconexión. Las métricas de todo token en seguimiento dejan de ser exactas. */
  onGapStart(at: number, reason: string): void {
    if (this.openGapId !== null) return;
    this.stats.gaps++;
    const r = this.db.query("INSERT INTO gaps(from_at, reason) VALUES (?, ?)").run(at, reason);
    this.openGapId = Number(r.lastInsertRowid);
    for (const t of this.tokens.values()) t.markGap();
    for (const p of this.positions.values()) p.gapped = true;
    for (const o of [...this.pending]) if (o.side === "buy") this.cancelOrder(o, "gap", at);
    this.db.query("UPDATE tokens SET gapped = 1 WHERE dropped_at IS NULL").run();
    this.log.warn(`hueco del feed (${reason}): ${this.tokens.size} tokens invalidados`);
  }

  onGapEnd(at: number): void {
    if (this.openGapId === null) return;
    this.db.query("UPDATE gaps SET to_at = ? WHERE id = ?").run(at, this.openGapId);
    this.openGapId = null;
  }

  // ── decisiones ───────────────────────────
  private maybeEvaluate(token: TokenState, now: number): void {
    const m = this.meta.get(token.mint);
    if (!m || m.decided) return;
    if (now - m.lastEvalAt < 1_000) return;
    m.lastEvalAt = now;
    if (m.trail.length < this.cfg.limits.maxTrailPerToken) m.trail.push([now, token.price]);
    const metrics = token.metrics(now);
    const verdict = evaluateCandidate(metrics, { initialVSolLamports: token.initialVSol }, this.cfg);
    if (verdict.reason === "too_young" || verdict.reason === "inactive") return;
    // "Mejor momento" del token: mayor score; a igual score, el filtro que falló más cerca de la entrada.
    if (
      !m.best ||
      verdict.score.score > m.best.verdict.score.score ||
      (verdict.score.score === m.best.verdict.score.score && reasonRank(verdict.reason) > reasonRank(m.best.verdict.reason))
    ) {
      m.best = { at: now, verdict, metrics, price: token.price };
    }
    if (!verdict.enter) return;
    const port = evaluatePortfolio(
      { openPositions: this.positions.size + this.pending.filter((o) => o.side === "buy").length, cashSol: this.cashSol, alreadyOpen: this.positions.has(token.mint), alreadyTraded: this.traded.has(token.mint) },
      this.cfg,
    );
    if (!port.ok) {
      // Señal válida bloqueada por la cartera: se registra como decisión (su desenlace también cuenta).
      this.recordDecision(token, now, false, port.reason, verdict, metrics, token.price, now);
      return;
    }
    const decisionId = this.recordDecision(token, now, true, "enter", verdict, metrics, token.price, now);
    this.placeOrder({ mint: token.mint, side: "buy", decidedAt: now, reason: "enter", sizeSol: port.sizeSol, positionId: decisionId });
    this.log.info(`ENTRADA decidida ${token.symbol} ${token.mint.slice(0, 8)} score=${verdict.score.score.toFixed(2)} size=${port.sizeSol.toFixed(3)} SOL`);
  }

  private recordDecision(token: TokenState, at: number, entered: boolean, reason: DiscardReason | "enter", verdict: Verdict, metrics: TokenMetrics, price: number, now: number): number {
    const m = this.meta.get(token.mint);
    if (m) {
      m.decided = true;
      // Crudos: solo de tokens con decisión (candidatos). Se vuelca la historia reciente en memoria y, desde aquí, cada trade.
      if (!m.rawStored) {
        m.rawStored = true;
        for (const t of token.recentTrades()) this.pushRaw([t.at, token.createdSlot, t.signature, token.mint, t.user, t.isBuy ? 1 : 0, t.solLamports, t.tokenRaw, t.vSol, t.vTok]);
      }
    }
    // Horizontes ya vencidos entre `at` y `now`: precio del rastro en ese instante (última muestra ≤ at + h).
    const trail = m?.trail ?? [];
    const priceAt = (t: number): number => {
      let p = price;
      for (const [ts, px] of trail) {
        if (ts > t) break;
        p = px;
      }
      return p;
    };
    const horizons = this.cfg.tracking.outcomeHorizonsMs;
    const filled: boolean[] = [];
    const pre: (number | null)[] = [];
    for (const h of horizons) {
      const due = at + h <= now;
      filled.push(due);
      pre.push(due ? priceAt(at + h) : null);
    }
    const latest = trail.length > 0 ? trail[trail.length - 1][1] : price;
    this.stats.decisions++;
    if (entered) this.stats.entries++;
    const r = this.db
      .query("INSERT INTO decisions(mint, decided_at, entered, reason, score, metrics_json, price_sol, strategy_version, config_hash) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(token.mint, at, entered ? 1 : 0, reason, verdict.score.score, JSON.stringify({ ...metrics, scoreParts: verdict.score }), price, this.version, this.hash);
    const id = Number(r.lastInsertRowid);
    const ret = (p: number | null) => (p === null || price <= 0 ? null : (p / price - 1) * 100);
    this.db
      .query("INSERT INTO outcomes(decision_id, mint, decided_at, price_0, price_5m, ret_5m, price_1h, ret_1h, price_24h, ret_24h, last_price, last_price_at, graduated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, token.mint, at, price, pre[0], ret(pre[0]), pre[1], ret(pre[1]), pre[2], ret(pre[2]), latest, now, token.migrated ? 1 : 0);
    const w: OutcomeWatch = { decisionId: id, mint: token.mint, decidedAt: at, price0: price, lastPrice: latest, lastPriceAt: now, filled, graduated: token.migrated };
    this.addWatch(w);
    this.db.query("UPDATE tokens SET status = ? WHERE mint = ?").run(entered ? "entered" : "discarded", token.mint);
    return id;
  }

  // ── órdenes ──────────────────────────────
  private placeOrder(o: Omit<PendingOrder, "id" | "executeAfter" | "timeoutAt">): PendingOrder {
    const order: PendingOrder = {
      ...o,
      id: this.nextOrderId++,
      executeAfter: o.decidedAt + this.cfg.sim.latencyMs,
      timeoutAt: o.decidedAt + this.cfg.sim.latencyMs + (o.side === "buy" ? this.cfg.sim.buyFillTimeoutMs : this.cfg.sim.sellDeadTimeoutMs),
    };
    this.pending.push(order);
    this.db
      .query("INSERT INTO orders(id, position_id, mint, side, decided_at, execute_after, status, reason, sol_amount, tokens_raw) VALUES (?,?,?,?,?,?,'pending',?,?,?)")
      .run(order.id, order.positionId ?? null, order.mint, order.side, order.decidedAt, order.executeAfter, order.reason, order.sizeSol ?? null, order.tokensRaw ?? null);
    if (order.side === "sell") {
      const p = this.positions.get(order.mint);
      if (p) p.sellPending = true;
    }
    return order;
  }

  private cancelOrder(o: PendingOrder, note: string, at: number): void {
    const i = this.pending.indexOf(o);
    if (i >= 0) this.pending.splice(i, 1);
    this.db.query("UPDATE orders SET status = 'cancelled', note = ?, filled_at = ? WHERE id = ?").run(note, at, o.id);
    if (o.side === "sell") {
      const p = this.positions.get(o.mint);
      if (p) p.sellPending = false;
    }
  }

  private cancelPendingFor(mint: string, note: string): void {
    for (const o of [...this.pending]) if (o.mint === mint) this.cancelOrder(o, note, o.decidedAt);
  }

  private fillPending(mint: string, at: number, curve: CurveState, feeBps: number | null, signature: string): void {
    for (const o of [...this.pending]) {
      if (o.mint !== mint || at < o.executeAfter) continue;
      if (o.side === "buy") this.executeBuy(o, at, curve, feeBps, signature);
      else {
        const p = this.positions.get(mint);
        if (!p) {
          this.cancelOrder(o, "position_gone", at);
          continue;
        }
        this.removePending(o);
        this.executeSell(p, o.tokensRaw ?? p.tokensRemaining, at, curve, feeBps, o.reason as ExitReason, o, { note: null, decidedAt: o.decidedAt, signature });
      }
    }
  }

  private removePending(o: PendingOrder): void {
    const i = this.pending.indexOf(o);
    if (i >= 0) this.pending.splice(i, 1);
  }

  private executeBuy(o: PendingOrder, at: number, curve: CurveState, feeBps: number | null, signature: string): void {
    this.removePending(o);
    const token = this.tokens.get(o.mint);
    const fill = simulateBuy(curve, o.sizeSol ?? 0, feeBps, this.cfg);
    if (fill.tokensRaw <= 0 || fill.solSpent > this.cashSol) {
      this.db.query("UPDATE orders SET status = 'cancelled', note = 'no_tokens_or_cash', filled_at = ? WHERE id = ?").run(at, o.id);
      return;
    }
    this.cashSol -= fill.solSpent;
    this.persistCash();
    const entryExecPct = executablePnlPct(curve, fill.tokensRaw, fill.solSpent, 0, feeBps, this.cfg);
    const r = this.db
      .query(
        "INSERT INTO positions(mint, decision_id, opened_at, tokens_raw, tokens_remaining, cost_sol, costs_sol, entry_price, entry_exec_pct, strategy_version, config_hash, gapped) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(o.mint, o.positionId ?? 0, at, fill.tokensRaw, fill.tokensRaw, fill.solSpent, fill.pumpFeeSol + fill.mevSol + fill.txFeeSol, fill.priceSol, entryExecPct, this.version, this.hash, token?.gapped ? 1 : 0);
    const positionId = Number(r.lastInsertRowid);
    this.db
      .query(
        "UPDATE orders SET status = 'filled', position_id = ?, filled_at = ?, ref_signature = ?, latency_ms = ?, sol_amount = ?, tokens_raw = ?, price_sol = ?, pump_fee_sol = ?, mev_sol = ?, tx_fee_sol = ?, fee_bps = ? WHERE id = ?",
      )
      .run(positionId, at, signature, at - o.decidedAt, fill.solSpent, fill.tokensRaw, fill.priceSol, fill.pumpFeeSol, fill.mevSol, fill.txFeeSol, fill.feeBpsUsed, o.id);
    this.positions.set(o.mint, {
      id: positionId,
      mint: o.mint,
      dev: token?.dev ?? "",
      decisionId: o.positionId ?? 0,
      openedAt: at,
      tokensRaw: fill.tokensRaw,
      tokensRemaining: fill.tokensRaw,
      costSol: fill.solSpent,
      proceedsSol: 0,
      costsSol: fill.pumpFeeSol + fill.mevSol + fill.txFeeSol,
      entryPrice: fill.priceSol,
      entryExecPct,
      peakPct: entryExecPct,
      takeProfitDone: [],
      devSold: token?.devSold ?? false,
      migrated: token?.migrated ?? false,
      gapped: token?.gapped ?? false,
      sellPending: false,
    });
    this.traded.admit(o.mint);
    this.log.info(`COMPRA simulada ${o.mint.slice(0, 8)} ${fill.solSpent.toFixed(4)} SOL → ${(fill.tokensRaw / 1e6).toFixed(0)} tok @ ${fill.priceSol.toExponential(3)} (latencia ${at - o.decidedAt} ms)`);
  }

  private executeSell(
    p: Position,
    tokensRaw: number,
    at: number,
    curve: CurveState,
    feeBps: number | null,
    reason: ExitReason,
    order: PendingOrder | null,
    opts: { penalty?: number; note: string | null; decidedAt: number; signature?: string },
  ): void {
    const qty = Math.min(tokensRaw, p.tokensRemaining);
    if (qty <= 0) return;
    const fill = simulateSell(curve, qty, feeBps, this.cfg, opts.penalty ?? 0);
    this.cashSol += fill.solReceived;
    this.persistCash();
    p.tokensRemaining -= qty;
    p.proceedsSol += fill.solReceived;
    p.costsSol += fill.pumpFeeSol + fill.mevSol + fill.txFeeSol;
    p.sellPending = false;
    if (order?.takeProfitIndex !== undefined) p.takeProfitDone.push(order.takeProfitIndex);
    const orderId = order?.id ?? this.nextOrderId++;
    if (order) {
      this.db
        .query(
          "UPDATE orders SET status = 'filled', filled_at = ?, ref_signature = ?, latency_ms = ?, sol_amount = ?, tokens_raw = ?, price_sol = ?, pump_fee_sol = ?, mev_sol = ?, tx_fee_sol = ?, fee_bps = ?, note = ? WHERE id = ?",
        )
        .run(at, opts.signature ?? null, at - opts.decidedAt, fill.solReceived, qty, fill.priceSol, fill.pumpFeeSol, fill.mevSol, fill.txFeeSol, fill.feeBpsUsed, opts.note, orderId);
    } else {
      this.db
        .query(
          "INSERT INTO orders(id, position_id, mint, side, decided_at, execute_after, status, filled_at, latency_ms, sol_amount, tokens_raw, price_sol, pump_fee_sol, mev_sol, tx_fee_sol, fee_bps, reason, note) VALUES (?,?,?,'sell',?,?,'filled',?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(orderId, p.id, p.mint, opts.decidedAt, opts.decidedAt, at, at - opts.decidedAt, fill.solReceived, qty, fill.priceSol, fill.pumpFeeSol, fill.mevSol, fill.txFeeSol, fill.feeBpsUsed, reason, opts.note);
    }
    const closed = p.tokensRemaining <= 0;
    const pnlSol = p.proceedsSol - p.costSol;
    const pnlPct = (pnlSol / p.costSol) * 100;
    if (closed) {
      this.positions.delete(p.mint);
      // Nivel del stop en P&L total: referencia tras el fill + stopPct. El gap = fill real − nivel.
      const stopLevel = reason === "stop" ? p.entryExecPct + this.cfg.strategy.exits.stopPct : null;
      const stopGap = stopLevel !== null ? pnlPct - stopLevel : null;
      this.db
        .query(
          "UPDATE positions SET closed_at = ?, tokens_remaining = 0, proceeds_sol = ?, costs_sol = ?, exit_price = ?, pnl_sol = ?, pnl_pct = ?, peak_pct = ?, close_reason = ?, stop_level_pct = ?, stop_trigger_pct = ?, stop_fill_pct = ?, stop_gap_pct = ?, gapped = ? WHERE id = ?",
        )
        .run(at, p.proceedsSol, p.costsSol, fill.priceSol, pnlSol, pnlPct, p.peakPct, reason, stopLevel, order?.triggerPct ?? null, stopLevel !== null ? pnlPct : null, stopGap, p.gapped ? 1 : 0, p.id);
      this.log.info(`CIERRE ${p.mint.slice(0, 8)} ${reason} pnl=${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)} %)${stopGap !== null ? ` gap_stop=${stopGap.toFixed(1)} pp` : ""}`);
    } else {
      this.db.query("UPDATE positions SET tokens_remaining = ?, proceeds_sol = ?, costs_sol = ?, peak_pct = ? WHERE id = ?").run(p.tokensRemaining, p.proceedsSol, p.costsSol, p.peakPct, p.id);
    }
  }

  private manageExit(p: Position, now: number, curve: CurveState, feeBps: number | null, token: TokenState | undefined): void {
    if (p.sellPending || p.tokensRemaining <= 0) return;
    const pct = executablePnlPct(curve, p.tokensRemaining, p.costSol, p.proceedsSol, feeBps, this.cfg);
    if (pct > p.peakPct) p.peakPct = pct;
    const metrics = token?.metrics(now);
    const decision = evaluateExit(
      {
        execPnlPct: pct,
        entryExecPnlPct: p.entryExecPct,
        peakExecPnlPct: p.peakPct,
        heldMs: now - p.openedAt,
        devSold: p.devSold || (token?.devSold ?? false),
        migrated: p.migrated || (token?.migrated ?? false),
        reversalNetSol: metrics?.reversalNetSol ?? 0,
        takeProfitDone: p.takeProfitDone,
      },
      this.cfg,
    );
    if (!decision) return;
    const qty = decision.fraction >= 1 ? p.tokensRemaining : Math.min(p.tokensRemaining, Math.floor(p.tokensRaw * decision.fraction));
    this.placeOrder({ mint: p.mint, side: "sell", decidedAt: now, reason: decision.reason, tokensRaw: qty, positionId: p.id, takeProfitIndex: decision.takeProfitIndex, triggerPct: decision.reason === "stop" ? pct : undefined });
    this.log.info(`SALIDA decidida ${p.mint.slice(0, 8)} ${decision.reason} pnl_ejecutable=${pct.toFixed(1)} %`);
  }

  // ── tick periódico (≈1 s) ────────────────
  tick(now: number): void {
    // Órdenes vencidas.
    for (const o of [...this.pending]) {
      if (now < o.timeoutAt) continue;
      if (o.side === "buy") {
        this.cancelOrder(o, "no_fill", now);
        continue;
      }
      const p = this.positions.get(o.mint);
      const last = this.lastCurve.get(o.mint);
      this.removePending(o);
      if (!p || !last) {
        this.db.query("UPDATE orders SET status = 'cancelled', note = 'no_state', filled_at = ? WHERE id = ?").run(now, o.id);
        continue;
      }
      this.executeSell(p, o.tokensRaw ?? p.tokensRemaining, now, last.curve, last.feeBps, o.reason as ExitReason, o, { note: "dead_token_last_state", decidedAt: o.decidedAt, penalty: p.migrated ? this.cfg.sim.migrationExitPenalty : 0 });
    }
    // Salidas por tiempo (sin trade nuevo no hay otra evaluación).
    for (const p of [...this.positions.values()]) {
      const last = this.lastCurve.get(p.mint);
      if (!last) continue;
      this.manageExit(p, now, last.curve, last.feeBps, this.tokens.get(p.mint));
    }
    // Fin de la ventana de candidatura / fin del seguimiento.
    for (const [mint, t] of this.tokens) {
      const m = this.meta.get(mint)!;
      const age = now - t.createdAt;
      if (!m.decided && age > this.cfg.strategy.ageMaxMs) {
        if (m.best) this.recordDecision(t, m.best.at, false, m.best.verdict.reason as DiscardReason, m.best.verdict, m.best.metrics, m.best.price, now);
        else {
          m.decided = true;
          this.db.query("UPDATE tokens SET status = 'ignored' WHERE mint = ?").run(mint);
        }
      }
      if (age > this.cfg.tracking.trackWindowMs && !this.positions.has(mint) && !this.pending.some((o) => o.mint === mint)) this.dropToken(mint, now);
    }
    // Desenlaces.
    const horizons = this.cfg.tracking.outcomeHorizonsMs;
    for (const [mint, list] of this.watches) {
      for (const w of [...list]) {
        let changed = false;
        for (let i = 0; i < horizons.length; i++) {
          if (w.filled[i] || now < w.decidedAt + horizons[i]) continue;
          w.filled[i] = true;
          changed = true;
          const ret = w.price0 > 0 ? (w.lastPrice / w.price0 - 1) * 100 : null;
          const col = ["5m", "1h", "24h"][i];
          this.db.query(`UPDATE outcomes SET price_${col} = ?, ret_${col} = ? WHERE decision_id = ?`).run(w.lastPrice, ret, w.decisionId);
        }
        if (changed) {
          const done = w.filled.every(Boolean);
          this.persistWatch(w, done);
          if (done) this.removeWatch(w);
        }
      }
      if (list.length === 0) {
        this.watches.delete(mint);
        if (!this.positions.has(mint) && !this.tokens.has(mint)) this.lastCurve.delete(mint);
      }
    }
    this.flushRaw();
  }

  // ── topes por construcción ───────────────
  /** Cierra la ventana de un token: decisión pendiente (si la hay), agregados a la tabla y fuera de memoria. */
  private dropToken(mint: string, now: number): void {
    const t = this.tokens.get(mint);
    const m = this.meta.get(mint);
    if (!t) return;
    if (m && !m.decided) {
      if (m.best) this.recordDecision(t, m.best.at, false, m.best.verdict.reason as DiscardReason, m.best.verdict, m.best.metrics, m.best.price, now);
      else this.db.query("UPDATE tokens SET status = 'ignored' WHERE mint = ?").run(mint);
    }
    this.db
      .query("UPDATE tokens SET trades_seen = ?, volume_sol = ?, holders = ?, last_price = ?, peak_price = ?, last_trade_at = ?, dev_sold = ?, gapped = ?, dropped_at = ? WHERE mint = ?")
      .run(t.tradesSeen, t.volumeLamports / LAMPORTS_PER_SOL, t.balances.size, t.price, t.peakPrice, t.lastTradeAt, t.devSold ? 1 : 0, t.gapped ? 1 : 0, now, mint);
    this.tokens.delete(mint);
    this.meta.delete(mint);
    if (!this.positions.has(mint) && !this.watches.has(mint)) this.lastCurve.delete(mint);
  }

  private addWatch(w: OutcomeWatch): void {
    while (this.watchCount >= this.cfg.limits.maxOutcomeWatches) {
      // Cierra el desenlace más antiguo con lo que tenga (el Map conserva el orden de inserción).
      const first = this.watches.entries().next().value as [string, OutcomeWatch[]] | undefined;
      if (!first) break;
      const old = first[1][0];
      this.persistWatch(old, true);
      this.removeWatch(old);
      if (first[1].length === 0) {
        this.watches.delete(first[0]);
        if (!this.positions.has(first[0]) && !this.tokens.has(first[0])) this.lastCurve.delete(first[0]);
      }
    }
    const list = this.watches.get(w.mint) ?? [];
    list.push(w);
    this.watches.set(w.mint, list);
    this.watchCount++;
  }

  private removeWatch(w: OutcomeWatch): void {
    const list = this.watches.get(w.mint);
    if (!list) return;
    const i = list.indexOf(w);
    if (i >= 0) {
      list.splice(i, 1);
      this.watchCount--;
    }
  }

  private persistWatch(w: OutcomeWatch, done: boolean): void {
    const rugged = done && w.price0 > 0 && w.lastPrice <= w.price0 * (1 - this.cfg.tracking.rugDrawdown) ? 1 : 0;
    this.db.query("UPDATE outcomes SET last_price = ?, last_price_at = ?, graduated = ?, rugged = ?, done = ? WHERE decision_id = ?").run(w.lastPrice, w.lastPriceAt, w.graduated ? 1 : 0, rugged, done ? 1 : 0, w.decisionId);
  }

  private pushRaw(row: unknown[]): void {
    if (this.rawBuffer.length >= this.cfg.limits.maxRawBuffer) {
      this.rawBuffer.shift();
      this.rawDropped++;
    }
    this.rawBuffer.push(row);
  }

  /** Tamaño de cada estructura en memoria (heartbeat y soak test). */
  memoryStats(): { tokens: number; meta: number; watches: number; lastCurve: number; positions: number; pending: number; traded: number; dedupe: number; rawBuffer: number; maxWalletsInToken: number; maxTradesInToken: number; maxTrail: number } {
    let maxW = 0;
    let maxT = 0;
    for (const t of this.tokens.values()) {
      const s = t.sizes();
      if (s.balances > maxW) maxW = s.balances;
      if (s.trades > maxT) maxT = s.trades;
    }
    let maxTrail = 0;
    for (const m of this.meta.values()) if (m.trail.length > maxTrail) maxTrail = m.trail.length;
    return {
      tokens: this.tokens.size,
      meta: this.meta.size,
      watches: this.watchCount,
      lastCurve: this.lastCurve.size,
      positions: this.positions.size,
      pending: this.pending.length,
      traded: this.traded.size,
      dedupe: this.dedupe.size,
      rawBuffer: this.rawBuffer.length,
      maxWalletsInToken: maxW,
      maxTradesInToken: maxT,
      maxTrail,
    };
  }

  /** Equity = caja + lo que quedaría vendiendo cada posición ahora (neto de costes). */
  equitySol(): number {
    let eq = this.cashSol;
    for (const p of this.positions.values()) {
      const last = this.lastCurve.get(p.mint);
      if (!last || p.tokensRemaining <= 0) continue;
      eq += simulateSell(last.curve, p.tokensRemaining, last.feeBps, this.cfg, p.migrated ? this.cfg.sim.migrationExitPenalty : 0).solReceived;
    }
    return eq;
  }

  snapshotEquity(now: number, solUsd: number | null): void {
    this.db.query("INSERT OR REPLACE INTO equity(at, cash_sol, equity_sol, open_positions, sol_usd) VALUES (?,?,?,?,?)").run(now, this.cashSol, this.equitySol(), this.positions.size, solUsd);
  }

  /** Aserción de la regla del dueño: ninguna posición puede superar los 5 días. */
  assertMaxHold(now: number): void {
    for (const p of this.positions.values()) {
      if (now - p.openedAt > this.cfg.strategy.exits.hardMaxHoldMs) throw new Error(`posición ${p.mint} abierta más de 5 días`);
    }
  }

  flushRaw(): void {
    if (this.rawBuffer.length === 0) return;
    const rows = this.rawBuffer.splice(0, this.rawBuffer.length);
    const stmt = this.db.query("INSERT INTO raw_trades(received_at, slot, signature, mint, user, is_buy, sol_lamports, token_raw, v_sol, v_tok) VALUES (?,?,?,?,?,?,?,?,?,?)");
    this.db.transaction(() => {
      for (const r of rows) stmt.run(...(r as [number, number, string, string, string, number, number, number, number, number]));
    })();
  }

  private persistCash(): void {
    this.db.query("UPDATE meta SET value = ? WHERE key = 'cash_sol'").run(String(this.cashSol));
  }
}
