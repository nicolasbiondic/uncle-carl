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

  // 2026-11-16: `positions.entry_exec_pct` (−6,3…−7,4 % en las 15 primeras entradas) se leyó como «la entrada
  // se ejecutó 7 % peor que el precio de decisión». Es otra cosa: lo que se cobraría vendiéndolo todo justo
  // tras comprar (comisión y MEV de ida y vuelta + impacto en la curva). El deslizamiento real, llenado frente
  // a decisión, medía +4,8 % de mediana (2,2 pp de ellos, comisión y MEV fijos). El informe da las dos cifras
  // con su nombre.
  describe("entrada: deslizamiento frente a la decisión y valor de salida inmediata, por separado", () => {
    const closedWith = (rows: Array<{ dec: number; fill: number; exec: number }>, extra: { sinOrden?: boolean } = {}) => {
      const db = openLabDb(":memory:");
      const insD = db.query("INSERT INTO decisions(mint, decided_at, entered, reason, score, metrics_json, price_sol, strategy_version, config_hash) VALUES (?,?,1,'enter',0.5,'{}',?,'v','h')");
      const insP = db.query(
        "INSERT INTO positions(mint, decision_id, opened_at, closed_at, tokens_raw, tokens_remaining, cost_sol, proceeds_sol, costs_sol, entry_price, entry_exec_pct, pnl_sol, pnl_pct, close_reason, strategy_version, config_hash) VALUES (?,?,?,?,1,0,1,1,0.03,?,?,0,0,'trailing','v','h')",
      );
      const insO = db.query(
        "INSERT INTO orders(position_id, mint, side, decided_at, execute_after, status, filled_at, latency_ms, sol_amount, tokens_raw, price_sol, pump_fee_sol, mev_sol, tx_fee_sol, fee_bps, reason) VALUES (?,?,'buy',?,?,'filled',?,1600,1,1,?,0.012,0.011,0.001,125,'enter')",
      );
      rows.forEach((r, i) => {
        const d = Number(insD.run(`m${i}`, T0, r.dec).lastInsertRowid);
        const p = Number(insP.run(`m${i}`, d, T0, T0 + 5 * MIN, r.fill, r.exec).lastInsertRowid);
        if (!extra.sinOrden) insO.run(p, `m${i}`, T0, T0, T0 + 1_600, r.fill);
      });
      return buildReport(db, { hours: 1, now: T0 + 30 * MIN, dbPath: ":memory:" });
    };

    test("da el llenado frente a la decisión (mediana) y el valor de salida inmediata como cifras distintas", () => {
      // llenado/decisión: +10 %, +5 %, −4 % → mediana +5,0 %; entry_exec_pct: −7, −6,5, −6 → mediana −6,5 %
      const text = closedWith([
        { dec: 1, fill: 1.1, exec: -7 },
        { dec: 1, fill: 1.05, exec: -6.5 },
        { dec: 1, fill: 0.96, exec: -6 },
      ]);
      expect(text).toMatch(/entrada: llenado frente al precio de decisión \+5\.0 % \(mediana de 3/);
      expect(text).toMatch(/2\.3 pp son comisión y MEV de la compra/);
      expect(text).toMatch(/valor de salida inmediata al comprar -6\.5 %/);
      expect(text).toContain("no es deslizamiento");
    });

    test("una posición sin orden de compra llenada no entra en la mediana, y sin ninguna no hay línea", () => {
      const text = closedWith([{ dec: 1, fill: 1.05, exec: -6.5 }], { sinOrden: true });
      expect(text).not.toContain("llenado frente al precio de decisión");
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("undefined");
    });
  });

  // 2026-11-15: el 92 % de «el dev vendió», el 88 % de «volumen bajo» y el 74 % de «pocos holders»
  // tenían retorno +1 h = 0: nadie operó el token tras la decisión, el último precio se arrastra y el
  // «0 %» parecía MEJOR que las entradas (-70 %). No es un resultado que se pudiera capturar.
  describe("ranking: un precio congelado no cuenta como «lo hicieron mejor»", () => {
    const setup = (rows: Array<[string, number, number]>) => {
      const db = openLabDb(":memory:");
      const ins = db.query("INSERT INTO decisions(mint, decided_at, entered, reason, score, metrics_json, price_sol, strategy_version, config_hash) VALUES (?,?,?,?,?,?,?,?,?)");
      const out = db.query("INSERT INTO outcomes(decision_id, mint, decided_at, price_0, ret_5m, ret_1h, ret_24h, rugged, graduated, last_price, last_price_at, done) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      let id = 0;
      for (const [reason, entered, ret1h] of rows) {
        id++;
        ins.run(`m${id}`, T0, entered, reason, 0.5, "{}", 1, "v", "h");
        out.run(id, `m${id}`, T0, 1, ret1h / 2, ret1h, ret1h, ret1h <= -90 ? 1 : 0, 0, 1 + ret1h / 100, T0, 1);
      }
      return buildReport(db, { hours: 1, now: T0 + 30 * MIN, dbPath: ":memory:" });
    };
    const many = (n: number, reason: string, entered: number, ret: number): Array<[string, number, number]> => Array.from({ length: n }, () => [reason, entered, ret]);

    test("un filtro cuyos descartados están casi todos congelados no se marca «relajar»", () => {
      const text = setup([...many(12, "enter", 1, -70), ...many(30, "dev_sold", 0, 0), ...many(12, "dev_sold", 0, -90)]);
      // 12 con movimiento a -90 %: eso es lo que se mide, no el 0 de los 30 congelados.
      expect(text).toMatch(/el dev vendió\s+\+1h\s+-90\.0 %.*\(n 12, 30 sin movimiento aparte\).*mantener/);
      expect(text).toMatch(/el dev vendió\s+n\s+42 .*30 sin movimiento a \+1 h/);
      expect(text).not.toMatch(/el dev vendió\s+\+1h\s+\+0\.0 %.*relajar/);
    });

    test("si tras quitar los congelados quedan menos de 10, el filtro no entra en el ranking", () => {
      const text = setup([...many(12, "enter", 1, -70), ...many(40, "low_volume", 0, 0), ...many(5, "low_volume", 0, 0.004)]);
      expect(text).not.toMatch(/volumen bajo\s+\+1h/);
      expect(text).toMatch(/volumen bajo.*45 sin movimiento a \+1 h/); // 40 en 0 y 5 en 0,004 %: todos dentro del ruido
    });

    test("un movimiento real pequeño pero fuera del ruido (±1 %) sigue contando", () => {
      const text = setup([...many(12, "enter", 1, -70), ...many(12, "top10_concentrated", 0, 3)]);
      expect(text).toMatch(/top 10 > límite\s+\+1h\s+\+3\.0 %.*\(n 12\).*relajar/);
    });
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
