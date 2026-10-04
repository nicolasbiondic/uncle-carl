// ══════════════════════════════════════════════
// Logger with colors and levels
// ══════════════════════════════════════════════

import { eventBus, EVENTS } from "./events";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "TRADE" | "SIGNAL";

// ── Error burst detection (Iter 7, 2026-05-04) ───
// Track recent ERROR-level lines per "shape" (= context + first 80 chars of
// message). When ≥10 of the same shape fire within 60s, emit an
// ERROR_BURST event so TelegramReporter can page on-call. Each shape can
// only re-fire after a 5-minute cooldown to avoid Telegram floods.
const ERROR_BURST_WINDOW_MS = 60_000;
const ERROR_BURST_THRESHOLD = 10;
const ERROR_BURST_COOLDOWN_MS = 5 * 60_000;
const errorTimestamps: Map<string, number[]> = new Map();
const lastBurstAt: Map<string, number> = new Map();

function recordError(context: string, message: string) {
  const shape = `${context}|${message.slice(0, 80)}`;
  const now = Date.now();
  const arr = errorTimestamps.get(shape) ?? [];
  // Drop entries outside the rolling window.
  while (arr.length > 0 && now - arr[0] > ERROR_BURST_WINDOW_MS) arr.shift();
  arr.push(now);
  errorTimestamps.set(shape, arr);

  if (arr.length >= ERROR_BURST_THRESHOLD) {
    const last = lastBurstAt.get(shape) ?? 0;
    if (now - last >= ERROR_BURST_COOLDOWN_MS) {
      lastBurstAt.set(shape, now);
      try {
        eventBus.emit(EVENTS.ERROR_BURST, {
          context,
          message,
          count: arr.length,
          windowMs: ERROR_BURST_WINDOW_MS,
          firstAt: arr[0],
          lastAt: arr[arr.length - 1],
        });
      } catch {
        // best-effort: never let logging crash the app
      }
    }
  }
}

const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[90m",
  INFO: "\x1b[36m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  TRADE: "\x1b[32m",
  SIGNAL: "\x1b[35m",
};

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  SIGNAL: 20,
  TRADE: 20,
  WARN: 30,
  ERROR: 40,
};

const RESET = "\x1b[0m";
const IS_TTY = !!process.stdout.isTTY;
const ENV_LOG_LEVEL = String(process.env.LOG_LEVEL || process.env.BOT_LOG_LEVEL || "INFO").toUpperCase() as LogLevel;
const MIN_LOG_RANK = LEVEL_RANK[ENV_LOG_LEVEL] ?? LEVEL_RANK.INFO;

class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= MIN_LOG_RANK;
  }

  private log(level: LogLevel, message: string, data?: any) {
    if (!this.shouldLog(level)) return;

    const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
    const color = COLORS[level];
    const rawPrefix = `[${ts}] [${level}] [${this.context}]`;
    const prefix = IS_TTY ? `${color}${rawPrefix}${RESET}` : rawPrefix;

    if (data !== undefined) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // Iter 7 fix (2026-05-04): track ERROR-level bursts and emit
    // ERROR_BURST when a single shape fires ≥10× in 60s.
    if (level === "ERROR") recordError(this.context, message);
  }

  debug(msg: string, data?: any) { this.log("DEBUG", msg, data); }
  info(msg: string, data?: any) { this.log("INFO", msg, data); }
  warn(msg: string, data?: any) { this.log("WARN", msg, data); }
  error(msg: string, data?: any) { this.log("ERROR", msg, data); }
  trade(msg: string, data?: any) { this.log("TRADE", msg, data); }
  signal(msg: string, data?: any) { this.log("SIGNAL", msg, data); }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
