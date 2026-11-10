/**
 * Soak sin red: ≥ 200 000 eventos sintéticos de ≥ 5 000 tokens contra el lab
 * con topes PEQUEÑOS para forzar el desalojo; cada estructura en memoria
 * debe quedar bajo su tope en todo momento. Cola acotada y reconexiones del
 * feed con socket y temporizadores falsos. Debe correr en < 20 s.
 */
import { describe, expect, test } from "bun:test";
import { LAB_CONFIG, PUMP_PROGRAM_ID, type LabConfig } from "./config";
import { openLabDb } from "./db";
import { PumpLogsFeed, type WebSocketLike } from "./feed";
import { MemecoinLab } from "./lab";
import { FrameQueue, Pipeline } from "./pipeline";
import { fakeKey, rng, TokenTape } from "./tape";

const T0 = 1_800_000_000_000;

const SOAK_CFG: LabConfig = {
  ...LAB_CONFIG,
  limits: {
    ...LAB_CONFIG.limits,
    maxTrackedTokens: 300,
    maxWalletsPerToken: 50,
    maxTradesPerToken: 60,
    maxTrailPerToken: 40,
    maxOutcomeWatches: 200,
    maxDedupeSignatures: 5_000,
    maxTradedMints: 20,
    maxRawBuffer: 500,
  },
};

describe("memecoin lab — soak (memoria acotada por construcción)", () => {
  test("≥ 200k eventos de ≥ 5k tokens: ningún mapa supera su tope; tiempo < 20 s", () => {
    const started = performance.now();
    const db = openLabDb(":memory:");
    const lab = new MemecoinLab(db, { cfg: SOAK_CFG, now: T0 });
    const r = rng(2026);
    const TOKENS = 5_200;
    const EVENTS_PER_TOKEN = 40;
    const SPAN = 90 * 60_000; // creaciones repartidas en 90 min
    // Un token "caliente" con muchas más wallets de las que cabe recordar.
    const hot = new TokenTape(r, T0 + 1_000, { symbol: "HOT" });
    for (let i = 0; i < 400; i++) hot.buy(T0 + 1_500 + i * 250, fakeKey(r), 0.05);
    const tapes: TokenTape[] = [hot];
    for (let k = 0; k < TOKENS; k++) {
      const t0 = T0 + Math.floor((k / TOKENS) * SPAN);
      const tape = new TokenTape(r, t0, { symbol: `T${k}` });
      const buyers = Math.floor(r() * 30) + 5;
      const bal = new Map<string, number>();
      for (let i = 0; i < EVENTS_PER_TOKEN - 1; i++) {
        const at = t0 + 300 + Math.floor(i * 4_000 * r());
        const w = tape.wallet(Math.floor(r() * buyers));
        const b = bal.get(w) ?? 0;
        if (b > 0 && r() < 0.3) {
          tape.sell(at, w, b);
          bal.set(w, 0);
        } else {
          const ev = tape.buy(at, w, 0.02 + r() * 0.3);
          bal.set(w, b + ev.tokenRaw);
        }
      }
      tape.entries.sort((a, b) => a.at - b.at);
      tapes.push(tape);
    }
    const all = tapes.flatMap((t) => t.entries).sort((a, b) => a.at - b.at);
    expect(all.length).toBeGreaterThanOrEqual(200_000);
    expect(tapes.length).toBeGreaterThanOrEqual(5_000);

    let nextTick = all[0].at;
    let checks = 0;
    const assertBounds = () => {
      const m = lab.memoryStats();
      expect(m.tokens).toBeLessThanOrEqual(SOAK_CFG.limits.maxTrackedTokens);
      expect(m.meta).toBe(m.tokens);
      expect(m.maxWalletsInToken).toBeLessThanOrEqual(SOAK_CFG.limits.maxWalletsPerToken);
      expect(m.maxTradesInToken).toBeLessThanOrEqual(SOAK_CFG.limits.maxTradesPerToken);
      expect(m.maxTrail).toBeLessThanOrEqual(SOAK_CFG.limits.maxTrailPerToken);
      expect(m.watches).toBeLessThanOrEqual(SOAK_CFG.limits.maxOutcomeWatches);
      expect(m.dedupe).toBeLessThanOrEqual(SOAK_CFG.limits.maxDedupeSignatures);
      expect(m.traded).toBeLessThanOrEqual(SOAK_CFG.limits.maxTradedMints);
      expect(m.rawBuffer).toBeLessThanOrEqual(SOAK_CFG.limits.maxRawBuffer);
      expect(m.lastCurve).toBeLessThanOrEqual(m.tokens + m.watches + m.positions);
      expect(m.pending).toBeLessThanOrEqual(SOAK_CFG.strategy.sizing.maxPositions * 2);
      checks++;
    };
    let i = 0;
    for (const e of all) {
      while (nextTick <= e.at) {
        lab.tick(nextTick);
        nextTick += 1_000;
      }
      lab.onNotification(e.n, e.at);
      if (++i % 2_000 === 0) assertBounds();
    }
    for (let k = 0; k < 40 * 60; k++) lab.tick(nextTick + k * 1_000);
    assertBounds();
    expect(checks).toBeGreaterThan(50);
    expect(lab.stats.evicted).toBeGreaterThan(0); // el tope de tokens actuó
    const hotRow = db.query<any, [string]>("SELECT gapped FROM tokens WHERE mint = ?").get(hot.mint);
    expect(hotRow.gapped).toBe(1); // overflow de wallets = métricas no exactas
    // Tras cerrar todas las ventanas, el estado por token queda vacío: nada crece con el tiempo de ejecución.
    const m = lab.memoryStats();
    expect(m.tokens).toBe(0);
    expect(m.lastCurve).toBeLessThanOrEqual(m.watches + m.positions);
    const elapsed = (performance.now() - started) / 1000;
    expect(elapsed).toBeLessThan(20);
  }, 30_000);

  test("cola acotada: nunca supera su capacidad, descarta y cuenta, abre y cierra un hueco", () => {
    const db = openLabDb(":memory:");
    const lab = new MemecoinLab(db, { cfg: SOAK_CFG, now: T0 });
    const scheduled: (() => void)[] = [];
    const pipe = new Pipeline(lab, { capacity: 1_000, drainBatch: 100, programId: PUMP_PROGRAM_ID, schedule: (fn) => scheduled.push(fn) });
    const frame = '{"jsonrpc":"2.0","method":"logsNotification","params":{"result":{"context":{"slot":1},"value":{"signature":"x","err":{"InstructionError":[0,"Custom"]},"logs":[]}},"subscription":1}}';
    for (let i = 0; i < 50_000; i++) pipe.onFrame(frame, T0 + i);
    expect(pipe.queue.size).toBe(1_000);
    expect(pipe.queue.maxSeen).toBe(1_000);
    expect(pipe.stats.dropped).toBe(49_000);
    expect(lab.stats.gaps).toBe(1);
    expect(db.query<any, []>("SELECT to_at FROM gaps").get().to_at).toBeNull();
    while (scheduled.length > 0) scheduled.shift()!();
    expect(pipe.queue.size).toBe(0);
    expect(pipe.stats.skippedFailed).toBe(1_000);
    expect(db.query<any, []>("SELECT to_at FROM gaps").get().to_at).not.toBeNull();
    // El ring buffer compacta: tras drenar, la cola no retiene referencias.
    const q = new FrameQueue(10);
    for (let i = 0; i < 5_000; i++) {
      q.push("a", i);
      q.shift();
    }
    expect(q.size).toBe(0);
    expect(q.dropped).toBe(0);
  });

  test("feed: tras 50 reconexiones hay UN socket vivo, ≤ 2 temporizadores y ningún handler en los viejos", () => {
    const sockets: (WebSocketLike & { closed: boolean })[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    let now = T0;
    const gaps: string[] = [];
    let ends = 0;
    const feed = new PumpLogsFeed({
      url: "wss://fake",
      programId: PUMP_PROGRAM_ID,
      commitment: "processed",
      silenceTimeoutMs: 20_000,
      backoff: { initial: 1_000, max: 60_000, factor: 2 },
      now: () => now,
      onFrame: () => {},
      onGapStart: (_at, reason) => gaps.push(reason),
      onGapEnd: () => ends++,
      log: { info() {}, warn() {}, error() {} },
      wsFactory: () => {
        const ws = { closed: false, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { this.closed = true; } } as WebSocketLike & { closed: boolean };
        sockets.push(ws);
        return ws;
      },
      timers: {
        setTimeout: (fn, _ms) => {
          const id = nextTimer++;
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (h) => {
          timers.delete(h as number);
        },
      },
    });
    const fire = () => {
      // Dispara el primer temporizador pendiente (reconexión o silencio).
      const [id, fn] = timers.entries().next().value as [number, () => void];
      timers.delete(id);
      fn();
    };
    feed.start();
    const open = (ws: WebSocketLike) => {
      ws.onopen?.({});
      ws.onmessage?.({ data: '{"jsonrpc":"2.0","result":123,"id":1}' });
    };
    open(sockets[0]);
    expect(feed.connected).toBe(true);
    for (let i = 0; i < 50; i++) {
      const cur = sockets[sockets.length - 1];
      now += 1_000;
      if (i % 2 === 0) cur.onclose?.({ code: 1006, reason: "abnormal" });
      else fire(); // silencio → cierre
      expect(feed.connected).toBe(false);
      expect(timers.size).toBeLessThanOrEqual(2);
      fire(); // temporizador de reconexión
      const next = sockets[sockets.length - 1];
      expect(next).not.toBe(cur);
      open(next);
      expect(feed.connected).toBe(true);
    }
    const live = sockets.filter((s) => !s.closed);
    expect(sockets.length).toBe(51);
    expect(live.length).toBe(1);
    for (const s of sockets.slice(0, -1)) {
      expect(s.onmessage).toBeNull();
      expect(s.onclose).toBeNull();
      expect(s.onopen).toBeNull();
    }
    expect(timers.size).toBeLessThanOrEqual(2);
    expect(feed.activeTimers).toBeLessThanOrEqual(2);
    expect(gaps.length).toBe(50);
    expect(ends).toBe(50);
    expect(feed.backoffMs(1)).toBe(1_000);
    expect(feed.backoffMs(4)).toBe(8_000);
    expect(feed.backoffMs(20)).toBe(60_000);
    feed.stop();
    expect(timers.size).toBe(0);
    expect(sockets.filter((s) => !s.closed).length).toBe(0);
  });
});
