import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fmtCircuitBreakerAlert, fmtPauseResolvedAlert, fmtErrorBurstAlert, fmtCloseAlert,
  fmtPnlPair, TelegramReporter, circuitProfileId, fmtRedesignRecommendation,
} from "./telegram-reporter";

// `send()` is the one choke point all call sites (digest, commands,
// OPEN/CLOSE, breakers, startup/shutdown) route through.
describe("send() delivers the message to the right chat, verbatim", () => {
  function reporterWithCapturedSend() {
    const reporter = new TelegramReporter();
    (reporter as any).enabled = true;
    (reporter as any).chatId = "123";
    let captured: any = null;
    (reporter as any).apiCall = async (_method: string, body: any) => {
      captured = body;
      return { ok: true };
    };
    return { reporter, getCaptured: () => captured };
  }

  test("a plain digest/command-style message ships as-is (the single-system cleanup removed the [instanceId] stamp)", async () => {
    const { reporter, getCaptured } = reporterWithCapturedSend();
    await reporter.send("📊 <b>STATUS</b> · stocks 🟢");
    expect(getCaptured().text).toBe("📊 <b>STATUS</b> · stocks 🟢");
    expect(getCaptured().chat_id).toBe("123");
  });

  test("a /start reply to an explicit chatId targets that chat (not only the default chat)", async () => {
    const { reporter, getCaptured } = reporterWithCapturedSend();
    await reporter.send("👋 Hola trader", "999");
    expect(getCaptured().chat_id).toBe("999");
  });
});

// 2026-08-03 user mandate: "Telegram is for the end user, not the developer
// — only trading operations, no restarts." The user chat must therefore be
// unreachable from any engineering event. These tests pin that boundary;
// they fail if someone adds a fallback from sendOps() to the user chat.
describe("audience split — engineering noise can never reach the user chat", () => {
  function reporterWithOps(opsChatId: string) {
    const reporter = new TelegramReporter();
    (reporter as any).enabled = true;
    (reporter as any).chatId = "USER";
    (reporter as any).opsChatId = opsChatId;
    const sent: any[] = [];
    (reporter as any).apiCall = async (_m: string, body: any) => { sent.push(body); return { ok: true }; };
    return { reporter, sent };
  }

  test("with an ops chat configured, an ops alert goes THERE and not to the user", async () => {
    const { reporter, sent } = reporterWithOps("OPS");
    await (reporter as any).sendOps("⚙️ Incidencia técnica · BrokerSync");
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe("OPS");
    expect(sent.some(m => m.chat_id === "USER")).toBe(false);
  });

  test("with NO ops chat (the default), the alert is dropped — never redirected to the user", async () => {
    const { reporter, sent } = reporterWithOps("");
    await (reporter as any).sendOps("⚙️ Incidencia técnica · BrokerSync");
    expect(sent).toHaveLength(0);
  });

  test("the ERROR_BURST and unexpected-restart paths call sendOps, not send", async () => {
    const src = readFileSync(join(import.meta.dir, "telegram-reporter.ts"), "utf8");
    // ERROR_BURST listener must route through sendOps
    const burst = src.slice(src.indexOf("EVENTS.ERROR_BURST"), src.indexOf("EVENTS.ERROR_BURST") + 260);
    expect(burst).toContain("sendOps(fmtErrorBurstAlert");
    // The unexpected-restart banner likewise
    const restart = src.slice(src.indexOf("reinicio inesperado") - 400, src.indexOf("reinicio inesperado"));
    expect(restart).toContain("sendOps(");
  });

  test("user-facing trading events still use the user chat: fills and closes", async () => {
    const src = readFileSync(join(import.meta.dir, "telegram-reporter.ts"), "utf8");
    const fills = src.slice(src.indexOf("EVENTS.ORDER_FILLED"), src.indexOf("EVENTS.POSITION_CLOSED"));
    expect(fills).toContain("this.send(");
    expect(fills).not.toContain("sendOps");
    const closes = src.slice(src.indexOf("EVENTS.POSITION_CLOSED"), src.indexOf("EVENTS.CIRCUIT_BREAKER"));
    expect(closes).toContain("this.send(");
    expect(closes).not.toContain("sendOps");
    // A circuit breaker STOPS the user's trading — it stays user-facing.
    const breaker = src.slice(src.indexOf("EVENTS.CIRCUIT_BREAKER"), src.indexOf("EVENTS.ERROR_BURST"));
    expect(breaker).toContain("this.send(");
    expect(breaker).not.toContain("sendOps");
  });
});

describe("shell notifiers target the ops chat, never the user chat", () => {
  for (const script of ["../../scripts/watchdog.sh", "../../scripts/auto-deploy.sh", "../../scripts/decommission-clone.sh"]) {
    test(`${script.split("/").pop()} uses TELEGRAM_OPS_CHAT_ID with no user-chat fallback`, () => {
      const src = readFileSync(join(import.meta.dir, script), "utf8");
      // The script must sendMessage (otherwise this test is vacuous)…
      expect(src).toContain("sendMessage");
      // …read the OPS chat…
      expect(src).toContain("TELEGRAM_OPS_CHAT_ID");
      // …and never source the user chat for a destination, whether inline
      // (chat_id=${TELEGRAM_CHAT_ID}) or via an intermediate variable
      // (chat=$(grep … TELEGRAM_CHAT_ID …)). Comments are stripped first so
      // documenting the rule doesn't trip it.
      const code = src.split("\n").filter((l: string) => !l.trim().startsWith("#")).join("\n");
      expect(code).not.toMatch(/TELEGRAM_CHAT_ID/);
    });
  }
});

// ── send()/apiCall() check `ok` and return real success/failure (B-ops-alerts.md #8) ──
// Previously apiCall returned Telegram's parsed body WITHOUT ever checking
// `ok`, so send() (and therefore sendOps/sendDaily/DailyReporter's
// telegram_sent) had no way to distinguish a real delivery from a rejected
// request that still parsed as JSON. These exercise the REAL apiCall/send
// path (not the `apiCall` override every other test in this file uses) by
// monkey-patching global `fetch` — restored in `finally` every time.
describe("send()/apiCall() — ok-checked delivery + 429 retry_after (B-ops-alerts.md #8)", () => {
  function reporterForRealHttp() {
    const reporter = new TelegramReporter();
    (reporter as any).enabled = true;
    (reporter as any).token = "1234567890:FAKE-TEST-TOKEN-ABCDEFGHIJK";
    (reporter as any).chatId = "555";
    return reporter;
  }

  test("send() returns true when Telegram confirms ok:true", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return Response.json({ ok: true, result: { message_id: 1 } }, { status: 200 });
    }) as any;
    try {
      const reporter = reporterForRealHttp();
      const ok = await reporter.send("hola");
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("api.telegram.org");
      expect(calls[0]).toContain("sendMessage");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("send() returns false when Telegram rejects the request (ok:false), even with a parseable JSON body", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 400, description: "chat not found" }, { status: 400 })) as any;
    try {
      const reporter = reporterForRealHttp();
      const ok = await reporter.send("hola");
      expect(ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a 429 (rate limited) is retried ONCE after the honored retry_after, and success on that retry is reported", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 });
      }
      return Response.json({ ok: true, result: {} }, { status: 200 });
    }) as any;
    try {
      const reporter = reporterForRealHttp();
      const start = Date.now();
      const ok = await reporter.send("hola");
      const elapsedMs = Date.now() - start;
      expect(calls).toBe(2); // one 429, one retry
      expect(ok).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(900); // the 1s retry_after was actually honored, not skipped
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 10_000);

  test("a 429 whose retry still fails after the wait reports false — not a silent success", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 });
    }) as any;
    try {
      const reporter = reporterForRealHttp();
      const ok = await reporter.send("hola");
      expect(calls).toBe(2); // still only ONE retry — never an unbounded loop
      expect(ok).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 10_000);
});

describe("Telegram alerts — specific & actionable (not generic)", () => {
  test("circuit-breaker alert states type, impact, resume time and the action", () => {
    const resumeAt = Date.now() + 3 * 3_600_000; // 3h out
    const msg = fmtCircuitBreakerAlert(
      { profileId: "momentum_crypto", reason: "Daily drawdown -8.20% exceeds -8% limit", resumeAt },
      { id: "momentum_crypto", equity: 24180, positions: 3 },
    );
    expect(msg).toContain("Momentum Cripto");
    expect(msg).toContain("drawdown diario");          // classified type
    expect(msg).toContain("-8.20%");                    // the precise reason
    expect(msg).toContain("$24,180");                   // impact: equity
    expect(msg).toContain("protegidas");                // open positions still protected
    expect(msg).toContain("ET");                        // human resume time
    expect(msg.toLowerCase()).toContain("panel");       // the action (resume from dashboard)
  });

  test("manual / no-resume pause says 'next session' not a bogus time", () => {
    const msg = fmtCircuitBreakerAlert({ profileId: "alpaca_high", reason: "Manual pause", resumeAt: 0 });
    expect(msg).toContain("pausa manual");
    expect(msg).toContain("la próxima sesión");
  });

  // B-ops-alerts.md #1: pause_started/pause_resolved TRANSITION events —
  // 372 blocked crypto ticks over 16 days paged nobody.
  test("pause_resolved renders a distinct RESOLVED message naming what it recovered from", () => {
    const msg = fmtPauseResolvedAlert(
      { profileId: "momentum_crypto", action: "pause_resolved", reason: "soft drawdown 11.0% — paused 24h" },
      { id: "momentum_crypto", equity: 24180 },
    );
    expect(msg).toContain("Momentum Cripto");
    expect(msg).toContain("reanuda entradas");
    expect(msg).toContain("soft drawdown 11.0%");
    expect(msg).toContain("$24,180");
    expect(msg).not.toContain("pausa preventiva"); // distinct from the STARTED shape
  });

  test("the CIRCUIT_BREAKER listener special-cases action=pause_resolved to fmtPauseResolvedAlert and recommend_redesign to fmtRedesignRecommendation; pause_started keeps fmtCircuitBreakerAlert", () => {
    const src = readFileSync(join(import.meta.dir, "telegram-reporter.ts"), "utf8");
    const breaker = src.slice(src.indexOf("EVENTS.CIRCUIT_BREAKER"), src.indexOf("EVENTS.ERROR_BURST"));
    expect(breaker).toContain('action === "pause_resolved"');
    expect(breaker).toContain("fmtPauseResolvedAlert");
    expect(breaker).toContain("fmtCircuitBreakerAlert");
  });

  test("error burst says it still runs + where to look", () => {
    const msg = fmtErrorBurstAlert({ context: "BrokerSync", count: 42, windowMs: 60000, message: "ECONNRESET" });
    expect(msg).toContain("BrokerSync");
    expect(msg).toContain("42 eventos");
    expect(msg).toContain("60s");
    expect(msg).toContain("sigue operando");
    expect(msg).not.toContain("./start.sh"); // el cliente no ejecuta shell
  });

  // The module context (e.g. BrokerSync) is what tells the operator WHERE
  // the burst fired — it must survive formatting.
  test("every technical page names the module context", () => {
    const msg = fmtErrorBurstAlert({ context: "BrokerSync", count: 3, windowMs: 60000, message: "x" });
    expect(msg).toContain("<code>BrokerSync</code>");
  });

  // A fresh process's first observation (windowMs 0/undefined) is a STATE,
  // not a rate — fabricating "en 60s" for it is exactly what paged the owner
  // with an invented "en 60s" for a first-ever drift observation.
  test("missing/zero windowMs omits the fabricated 'en Xs' clause", () => {
    const noWindow = fmtErrorBurstAlert({ context: "BrokerSync", count: 7, message: "drift" });
    expect(noWindow).not.toContain("en 0s");
    expect(noWindow).not.toContain("en 60s");
    expect(noWindow).toContain("7 eventos idénticos");

    const zeroWindow = fmtErrorBurstAlert({ context: "BrokerSync", count: 7, windowMs: 0, message: "drift" });
    expect(zeroWindow).not.toContain("en 0s");
  });

  test("a genuine windowMs still renders the 'en Xs' clause", () => {
    const msg = fmtErrorBurstAlert({ context: "BrokerSync", count: 5, windowMs: 120_000, message: "x" });
    expect(msg).toContain("en 120s");
  });

  test("a single event reads naturally, not '1 evento idéntico'", () => {
    const msg = fmtErrorBurstAlert({ context: "BrokerSync", count: 1, windowMs: 60_000, message: "x" });
    expect(msg).toContain("1 evento");
    expect(msg).not.toContain("1 evento idéntico");
  });

  // B-ops-alerts.md #4/#8: the blanket "trading sigue operando con
  // normalidad" used to fire indiscriminately — including for a stale
  // stop-loss loop or a naked position with no confirmed native stop, where
  // it is simply FALSE (protection may be reduced/absent).
  test("a generic ops burst (e.g. BrokerSync) keeps the normal reassurance", () => {
    const msg = fmtErrorBurstAlert({ context: "BrokerSync", count: 5, windowMs: 60_000, message: "ECONNRESET" });
    expect(msg).toContain("sigue operando con normalidad");
  });

  test("a stale sl_loop heartbeat does NOT claim trading is normal — that loop IS the stop-loss protection", () => {
    const msg = fmtErrorBurstAlert({ context: "heartbeat:sl_loop", count: 1, windowMs: 78_000, message: "sl_loop silent 78s" });
    expect(msg).not.toContain("sigue operando con normalidad");
    expect(msg.toLowerCase()).toContain("verificar");
  });

  test("a missing native-stop incident does NOT claim trading is normal", () => {
    const msg = fmtErrorBurstAlert({ context: "AccountManager.nativeStopMissing", count: 1, message: "AAPL: broker position OPEN with NO confirmed native stop" });
    expect(msg).not.toContain("sigue operando con normalidad");
  });

  test("a close-rejected (403, position live) incident does NOT claim trading is normal", () => {
    const msg = fmtErrorBurstAlert({ context: "AccountManager.closeRejected", count: 1, message: "AAPL: close rejected" });
    expect(msg).not.toContain("sigue operando con normalidad");
  });

  test("close alert: clear reason word + running day P&L (not a terse code)", () => {
    const t = { symbol: "BTC/USD", pnl: 42.18, pnlPct: 1.2, accountId: "binance_high",
      entryTime: 1000, exitTime: 1000 + 38 * 60_000, closeReason: "STOP_LOSS" };
    const msg = fmtCloseAlert(t, 120.5);
    expect(msg).toContain("BTC/USD");
    expect(msg).toContain("+$42.18");
    expect(msg).toContain("stop-loss");      // clear word, not "SL"
    expect(msg).toContain("abierta 38m");    // hold time
    expect(msg).toContain("cobrado hoy +$120.50"); // the sleeve's realized today — NOT the day's P&L
    expect(msg).not.toContain("día +$");
  });

  test("close alert: engine close labels read as words (was 'model_cutover')", () => {
    const msg = fmtCloseAlert({ symbol: "META", pnl: 4767.74, pnlPct: 19.6, accountId: "momentum_stocks",
      entryTime: Date.UTC(2026, 8, 4, 13, 48), exitTime: Date.UTC(2026, 8, 28, 13, 35), closeReason: "MODEL_CUTOVER" }, 5482.9);
    expect(msg).toContain("cambio de modelo");
    expect(msg).toContain("abierta 23d");
    expect(msg).not.toContain("model_cutover");
  });

  test("externally-reconciled close (broker 404) does NOT claim a $0.00 trade", () => {
    // Regression guard: a BROKER_GONE_404 close has pnl=0 placeholder because the
    // bot never executed a fill. It must NOT render "+$0.00 (+0.0%)" (misleading).
    for (const reason of ["BROKER_GONE_404", "MANUAL_CLOSE_UNRECONCILED", "BACKFILLED_SYNC", "SYNC_DETECTED"]) {
      const msg = fmtCloseAlert({ symbol: "XLF", pnl: 0, pnlPct: 0, accountId: "alpaca_high", close_reason: reason });
      expect(msg).toContain("XLF");
      expect(msg).toContain("directamente en el broker");
      expect(msg).not.toContain("$0.00");
      expect(msg).not.toContain("0.0%");
    }
  });

  test("fmtPnlPair: the percent sign always follows the dollar (centralized guard)", () => {
    // The realized dollar is truth; the percent must never contradict it.
    expect(fmtPnlPair(-34.4, 1.1)).toBe("−$34.40 (-1.1%)");   // loss: pct forced negative
    expect(fmtPnlPair(12.5, -0.8)).toBe("+$12.50 (+0.8%)");   // win: pct forced positive
    expect(fmtPnlPair(-10, -2)).toBe("−$10.00 (-2.0%)");      // already-consistent loss unchanged
    expect(fmtPnlPair(5, 1.07)).toBe("+$5.00 (+1.1%)");       // already-consistent win unchanged
    expect(fmtPnlPair(0, 0)).toBe("+$0.00 (0.0%)");           // flat
    expect(fmtPnlPair(-7, NaN)).toBe("−$7.00 (0.0%)");        // NaN pct → 0, no crash
  });

  test("close alert: pnl and pct can never disagree in sign (the −$34.40 (+1.1%) bug)", () => {
    // Reproduces the production screenshot: a Binance sync-close whose dollar pnl
    // (broker realizedPnl, a LOSS) was paired with a price-derived pct (a GAIN).
    // The dollar is the realized truth, so the pct sign must follow it.
    const loss = fmtCloseAlert(
      { symbol: "ETH/USD", pnl: -34.4, pnlPct: 1.1, accountId: "binance_high",
        entryTime: 1000, exitTime: 1000 + 160 * 60_000, closeReason: "STOP_LOSS" }, 5.34);
    expect(loss).toContain("−$34.40");         // signMoney uses U+2212 minus
    expect(loss).toContain("-1.1%");           // aligned to the dollar sign
    expect(loss).not.toContain("+1.1%");       // the contradictory line must never ship
    expect(loss).toContain("📉");              // loss emoji
    // Mirror case: a win paired with a negative pct gets aligned positive.
    const win = fmtCloseAlert(
      { symbol: "SOL/USD", pnl: 12.5, pnlPct: -0.8, accountId: "binance_low" }, 0);
    expect(win).toContain("+$12.50");
    expect(win).toContain("+0.8%");
    expect(win).not.toContain("-0.8%");
  });

});

describe("circuitProfileId — engine heartbeat names map to the profile ids the alerts are keyed by", () => {
  test("every live engine's heartbeat name resolves to its risk profile", () => {
    expect(circuitProfileId("momentum:stocks")).toBe("momentum_stocks");
    expect(circuitProfileId("momentum:crypto")).toBe("momentum_crypto");
    expect(circuitProfileId("momentum:crypto_usdc")).toBe("momentum_crypto_usdc");
    expect(circuitProfileId("momentum:btc")).toBe("momentum_btc");
    expect(circuitProfileId("meanrev:stocks")).toBe("meanrev_stocks");
  });

  test("an id that is already a profile (SleeveGovernor) or unknown passes through unchanged", () => {
    expect(circuitProfileId("momentum_crypto")).toBe("momentum_crypto");
    expect(circuitProfileId("shadow_pairs")).toBe("shadow_pairs");
    expect(circuitProfileId(undefined)).toBe("");
  });

  test("the CIRCUIT_BREAKER listener normalizes the id and leaves an activity row", () => {
    const src = readFileSync(join(import.meta.dir, "telegram-reporter.ts"), "utf8");
    const breaker = src.slice(src.indexOf("EVENTS.CIRCUIT_BREAKER"), src.indexOf("EVENTS.ERROR_BURST"));
    expect(breaker).toContain("circuitProfileId(");
    expect(breaker).toContain('insertActivity(');
  });
});

describe("owner rule: a failing strategy is redesigned, never switched off (2026-09-26)", () => {
  test("the governor's bleed recommendation asks for a redesign, says the sleeve keeps trading, and proposes no stop/pause/shadow", () => {
    const msg = fmtRedesignRecommendation({ profileId: "momentum_crypto", reason: "90d PnL $-120.00 over 34 trades" }, { equity: 5333 });
    expect(msg).toContain("rediseñar");
    expect(msg).toContain("Sigue operando");
    expect(msg.toLowerCase()).not.toMatch(/shadow|apagar|pausa|detener|desactivar|demot/);
  });

  test("the CIRCUIT_BREAKER listener routes recommend_redesign to its own formatter (never the pause template)", () => {
    const src = readFileSync(join(import.meta.dir, "telegram-reporter.ts"), "utf8");
    const breaker = src.slice(src.indexOf("EVENTS.CIRCUIT_BREAKER"), src.indexOf("EVENTS.ERROR_BURST"));
    expect(breaker).toContain('action === "recommend_redesign"');
    expect(breaker).toContain("fmtRedesignRecommendation");
  });

  test("no source file emits a demotion recommendation any more", () => {
    const gov = readFileSync(join(import.meta.dir, "../governor/SleeveGovernor.ts"), "utf8");
    expect(gov).not.toContain("recommend_demote");
    expect(gov).not.toContain("RECOMMEND_DEMOTE");
  });
});
