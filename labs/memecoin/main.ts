/**
 * Proceso del laboratorio de memecoins (paper, aislado del bot):
 *   bun labs/memecoin/main.ts [--minutes N] [--rpc wss://…] [--db ruta]
 *
 * Feed RPC → cola acotada → decodificador → lab → SQLite propio. Heartbeat
 * JSON en data/memecoin-lab.heartbeat cada 30 s (rss, heap, tokens, cola,
 * eventos/s, huecos). Si el RSS supera `limits.maxRssMb` el proceso registra
 * ERROR y sale con código 2: systemd (Restart=always) lo reinicia; mejor
 * reiniciar que crecer. Nada aquí firma ni envía transacciones.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "../../src/utils/logger";
import { LAB_CONFIG, PUMP_PROGRAM_ID, STRATEGY_VERSION } from "./config";
import { DEFAULT_DB_PATH, openLabDb, pruneRawTrades, setMeta } from "./db";
import { PumpLogsFeed } from "./feed";
import { MemecoinLab } from "./lab";
import { Pipeline } from "./pipeline";
import { buildReport } from "./report";
import { loadEnv, sendOps } from "./telegram";

const log = createLogger("memecoin-lab");
const HEARTBEAT_PATH = join(import.meta.dir, "..", "..", "data", "memecoin-lab.heartbeat");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function fetchSolUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(10_000) });
    const j: any = await res.json();
    const v = Number(j?.solana?.usd);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const cfg = LAB_CONFIG;
  const minutes = Number(arg("--minutes") ?? 0) || 0;
  const url = arg("--rpc") ?? process.env.MEMECOIN_RPC_WS ?? cfg.feed.rpcWsDefault;
  const dbPath = arg("--db") ?? DEFAULT_DB_PATH;
  const db = openLabDb(dbPath);
  const lab = new MemecoinLab(db, { cfg, log, now: Date.now() });
  const pipe = new Pipeline(lab, { capacity: cfg.feed.maxQueuedFrames, drainBatch: cfg.feed.drainBatch, programId: PUMP_PROGRAM_ID });
  const feed = new PumpLogsFeed({
    url,
    programId: PUMP_PROGRAM_ID,
    commitment: cfg.feed.commitment,
    silenceTimeoutMs: cfg.feed.silenceTimeoutMs,
    backoff: cfg.feed.reconnectBackoffMs,
    now: () => Date.now(),
    onFrame: (raw, at) => pipe.onFrame(raw, at),
    onGapStart: (at, reason) => lab.onGapStart(at, reason),
    onGapEnd: (at) => lab.onGapEnd(at),
    log,
  });
  log.info(`arranque ${STRATEGY_VERSION} config=${lab.hash} rpc=${url.replace(/api-key=[^&]+/, "api-key=***")} db=${dbPath} caja=${lab.cashSol.toFixed(4)} SOL${minutes ? ` (${minutes} min)` : ""}`);
  log.info(`⚠ cuenta PAPER: sin wallet, sin firma, sin envío de transacciones`);

  const startedAt = Date.now();
  const cpu0 = process.cpuUsage();
  let solUsd: number | null = await fetchSolUsd();
  let lastHb = { at: startedAt, frames: 0, bytes: 0, notifications: 0 };
  const rssSeries: number[] = [];
  let stopping = false;

  const heartbeat = () => {
    const now = Date.now();
    const mem = process.memoryUsage();
    const rssMb = mem.rss / 1_048_576;
    const dt = Math.max(1, (now - lastHb.at) / 1000);
    const framesPerS = (feed.stats.frames - lastHb.frames) / dt;
    const bytesPerS = (feed.stats.bytes - lastHb.bytes) / dt;
    const eventsPerS = (pipe.stats.notifications - lastHb.notifications) / dt;
    lastHb = { at: now, frames: feed.stats.frames, bytes: feed.stats.bytes, notifications: pipe.stats.notifications };
    const m = lab.memoryStats();
    const line = {
      at: now,
      iso: new Date(now).toISOString(),
      pid: process.pid,
      rss_mb: Math.round(rssMb * 10) / 10,
      heap_mb: Math.round((mem.heapUsed / 1_048_576) * 10) / 10,
      tokens: m.tokens,
      watches: m.watches,
      positions: m.positions,
      queue: pipe.queue.size,
      queue_max: pipe.queue.maxSeen,
      dropped: pipe.stats.dropped,
      events_per_s: Math.round(eventsPerS * 10) / 10,
      frames_per_s: Math.round(framesPerS),
      bytes_per_s: Math.round(bytesPerS),
      gb_per_day: Math.round((bytesPerS * 86_400) / 1e7) / 100,
      gaps: lab.stats.gaps,
      connected: feed.connected,
      cash_sol: Math.round(lab.cashSol * 1e6) / 1e6,
      uptime_s: Math.round((now - startedAt) / 1000),
    };
    rssSeries.push(line.rss_mb);
    if (rssSeries.length > 120) rssSeries.shift(); // 24/7: keep only the last 120 heartbeats
    try {
      writeFileSync(HEARTBEAT_PATH, JSON.stringify(line) + "\n");
      setMeta(db, "last_heartbeat", line.iso);
      setMeta(db, "bytes_per_s", String(line.bytes_per_s));
    } catch (e) {
      log.warn(`heartbeat no escrito: ${String(e)}`);
    }
    log.info(`hb rss=${line.rss_mb}MB heap=${line.heap_mb}MB tokens=${m.tokens} watches=${m.watches} cola=${line.queue}/${line.queue_max} ev/s=${line.events_per_s} frames/s=${line.frames_per_s} ${line.gb_per_day} GB/día huecos=${line.gaps} dup=${lab.stats.duplicates}`);
    if (rssMb > cfg.limits.maxRssMb) {
      log.error(`RSS ${line.rss_mb} MB > ${cfg.limits.maxRssMb} MB: salida con código 2 para que systemd reinicie limpio`);
      shutdown(2);
    }
  };

  const timers: ReturnType<typeof setInterval>[] = [];
  timers.push(
    setInterval(() => {
      const now = Date.now();
      lab.tick(now);
      lab.assertMaxHold(now);
    }, 1_000),
  );
  timers.push(setInterval(heartbeat, cfg.feed.heartbeatIntervalMs));
  timers.push(setInterval(() => lab.snapshotEquity(Date.now(), solUsd), 60_000));
  timers.push(
    setInterval(() => {
      const n = pruneRawTrades(db, Date.now(), cfg.tracking.rawRetentionDays);
      if (n > 0) log.info(`retención: ${n} filas crudas borradas (> ${cfg.tracking.rawRetentionDays} días)`);
    }, 3_600_000),
  );
  timers.push(
    setInterval(() => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA optimize");
      } catch (e) {
        log.warn(`checkpoint WAL: ${String(e)}`);
      }
    }, 86_400_000),
  );
  timers.push(
    setInterval(async () => {
      const v = await fetchSolUsd();
      if (v) solUsd = v;
    }, 3_600_000),
  );
  // Resumen diario a Telegram (chat de OPS) a la hora UTC configurada; si falla, solo log.
  const dailyHour = Number(process.env.MEMECOIN_DAILY_HOUR_UTC ?? 12);
  timers.push(
    setInterval(async () => {
      const now = new Date();
      const key = now.toISOString().slice(0, 10);
      if (now.getUTCHours() !== dailyHour || db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'last_daily_report'").get()?.value === key) return;
      setMeta(db, "last_daily_report", key);
      const text = buildReport(db, { hours: 24, now: Date.now(), dbPath });
      const ok = await sendOps(text, log);
      log.info(`resumen diario ${ok ? "enviado" : "NO enviado (ver aviso)"}`);
    }, 60_000),
  );

  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const t of timers) clearInterval(t);
    feed.stop();
    pipe.drain(Number.MAX_SAFE_INTEGER);
    const now = Date.now();
    lab.tick(now);
    lab.flushRaw();
    lab.snapshotEquity(now, solUsd);
    const cpu = process.cpuUsage(cpu0);
    const wallS = (now - startedAt) / 1000;
    const cpuPct = ((cpu.user + cpu.system) / 1e6 / wallS) * 100;
    let dbMb = 0;
    try {
      dbMb = (Bun.file(dbPath).size + (Bun.file(dbPath + "-wal").size || 0)) / 1_048_576;
    } catch {}
    log.info(
      `fin: ${wallS.toFixed(0)} s · frames ${feed.stats.frames} (${(feed.stats.bytes / 1_048_576).toFixed(1)} MB ≈ ${((feed.stats.bytes / wallS) * 86_400 / 1e9).toFixed(1)} GB/día) · notificaciones ${pipe.stats.notifications} · fallidas descartadas ${pipe.stats.skippedFailed} · sin eventos ${pipe.stats.skippedNoEvents} · descartadas por cola ${pipe.stats.dropped} · creates ${lab.stats.creates} · trades ${lab.stats.trades} (vigilados ${lab.stats.tradesTracked}) · completes ${lab.stats.completes} · duplicados ${lab.stats.duplicates} · decisiones ${lab.stats.decisions} · entradas ${lab.stats.entries} · huecos ${lab.stats.gaps} · CPU media ${cpuPct.toFixed(1)} % · RSS serie [${rssSeries.map((x) => x.toFixed(0)).join(", ")}] MB · base ${dbMb.toFixed(2)} MB`,
    );
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    db.close();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (e) => {
    log.error(`uncaughtException: ${String(e?.stack ?? e)}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (e) => {
    log.error(`unhandledRejection: ${String((e as Error)?.stack ?? e)}`);
    shutdown(1);
  });

  feed.start();
  heartbeat();
  if (minutes > 0) setTimeout(() => shutdown(0), minutes * 60_000);
}

main().catch((e) => {
  log.error(`fallo de arranque: ${String(e?.stack ?? e)}`);
  process.exit(1);
});
