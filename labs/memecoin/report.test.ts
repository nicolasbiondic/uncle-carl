import { describe, expect, test } from "bun:test";
import { LAB_CONFIG } from "./config";
import { openLabDb } from "./db";
import { MemecoinLab } from "./lab";
import { buildReport } from "./report";
import { fomoTape, playTapes, pumpAndDumpTape } from "./tape";
import { chunkMessage, opsTarget, sendOps } from "./telegram";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

describe("memecoin lab — informe", () => {
  test("informe sobre una base con entradas, descartes y desenlaces: secciones y cifras en español", () => {
    const db = openLabDb(":memory:");
    const lab = new MemecoinLab(db, { now: T0 });
    const tapes = [fomoTape(1, T0, { symbol: "A" }), pumpAndDumpTape(2, T0 + 30_000, 162_000), fomoTape(3, T0 + 60_000, { buyers: 20, symbol: "C" })];
    playTapes(lab, tapes, T0 + 80 * MIN);
    for (let t = T0; t <= T0 + 80 * MIN; t += 5 * MIN) lab.snapshotEquity(t, 150);
    const text = buildReport(db, { hours: 2, now: T0 + 80 * MIN, dbPath: ":memory:" });
    for (const s of ["SALDO", "OPERACIONES CERRADAS", "EMBUDO", "APRENDIZAJE", "QUÉ CAMBIAR", "FEED Y RECURSOS", "No es dinero real", "win rate", "gap medio del stop", "costes", "USD/SOL, informativo"]) expect(text).toContain(s);
    expect(text).toContain("fomo-momentum@v1");
    expect(text).toContain(`entradas ${db.query<any, []>("SELECT COUNT(*) AS c FROM positions").get().c}`);
    expect(text).toMatch(/descarte «[^»]+»: \d+/);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });

  test("ranking: un filtro cuyos descartados suben a +1 h se marca «relajar», uno que evitó pérdidas «mantener»", () => {
    const db = openLabDb(":memory:");
    const ins = db.query("INSERT INTO decisions(mint, decided_at, entered, reason, score, metrics_json, price_sol, strategy_version, config_hash) VALUES (?,?,?,?,?,?,?,?,?)");
    const out = db.query("INSERT INTO outcomes(decision_id, mint, decided_at, price_0, ret_5m, ret_1h, ret_24h, rugged, graduated, last_price, last_price_at, done) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    let id = 0;
    const add = (reason: string, entered: number, ret1h: number) => {
      id++;
      ins.run(`m${id}`, T0, entered, reason, 0.5, "{}", 1, "v", "h");
      out.run(id, `m${id}`, T0, 1, ret1h / 2, ret1h, ret1h, ret1h <= -90 ? 1 : 0, 0, 1 + ret1h / 100, T0, 1);
    };
    for (let i = 0; i < 12; i++) add("enter", 1, 2);
    for (let i = 0; i < 12; i++) add("top10_concentrated", 0, 40);
    for (let i = 0; i < 12; i++) add("dev_sold", 0, -95);
    for (let i = 0; i < 3; i++) add("low_volume", 0, 500); // n < 10: no entra en el ranking
    const text = buildReport(db, { hours: 1, now: T0 + 30 * MIN, dbPath: ":memory:" });
    expect(text).toMatch(/top 10 > límite\s+\+1h\s+\+40\.0 %.*relajar/);
    expect(text).toMatch(/el dev vendió\s+\+1h\s+-95\.0 %.*mantener/);
    expect(text).not.toMatch(/volumen bajo\s+\+1h/);
    expect(text).toContain("rug 100 %");
  });
});

describe("memecoin lab — Telegram (solo chat de OPS, sin fallback)", () => {
  test("sin token/chat de OPS no se envía nada aunque exista TELEGRAM_CHAT_ID", () => {
    expect(opsTarget({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "999" })).toBeNull();
    expect(opsTarget({ TELEGRAM_BOT_TOKEN: "your_telegram_bot_token", TELEGRAM_OPS_CHAT_ID: "1" })).toBeNull();
    expect(opsTarget({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_OPS_CHAT_ID: "-100" })).toEqual({ token: "123:abc", chatId: "-100" });
  });

  test("envío confirmado solo con ok:true; el fallo se registra y devuelve false", async () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m) };
    const calls: any[] = [];
    const okFetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendOps("hola <b>", log, okFetch, { token: "t", chatId: "-1" })).toBe(true);
    expect(calls[0].url).toBe("https://api.telegram.org/bott/sendMessage");
    expect(calls[0].body.chat_id).toBe("-1");
    expect(calls[0].body.text).toContain("&lt;b&gt;");
    const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await sendOps("x", log, badFetch, { token: "t", chatId: "-1" })).toBe(false);
    const throwing = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    expect(await sendOps("x", log, throwing, { token: "t", chatId: "-1" })).toBe(false);
    expect(await sendOps("x", log, okFetch, null)).toBe(false);
    expect(warns.length).toBe(3);
  });

  test("mensajes largos se trocean por debajo del límite de Telegram", () => {
    const parts = chunkMessage("a".repeat(10_000) + "\n" + "b".repeat(100), 3_900);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3_900);
    expect(parts.join("")).toBe("a".repeat(10_000) + "\n" + "b".repeat(100));
    expect(LAB_CONFIG.feed.heartbeatIntervalMs).toBe(30_000);
  });
});
