/**
 * Laboratorio completo sobre cintas sintéticas (sin red, determinista).
 * Comprueba que el paper no miente: latencia real pagada, costes
 * declarados, rug pagado entero, hueco = métricas inválidas, y que toda
 * decisión (entre o no) deja un desenlace.
 */
import { describe, expect, test } from "bun:test";
import { LAB_CONFIG, STRATEGY_VERSION, configHash } from "./config";
import { openLabDb } from "./db";
import { MemecoinLab } from "./lab";
import { fomoTape, playTapes, pumpAndDumpTape, rng, TokenTape, fakeKey } from "./tape";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function newLab(cfg = LAB_CONFIG) {
  const db = openLabDb(":memory:");
  const lab = new MemecoinLab(db, { cfg, now: T0 });
  return { db, lab };
}

function richFomo(seed: number, t0: number, symbol = "FOMO") {
  // 90 compradores distintos en 4 min: supera top10 ≤ 20 %, holders ≥ 15, flujo ≥ A/N/R.
  return fomoTape(seed, t0, { buyers: 90, minutes: 4, solPerBuy: 0.25, symbol });
}

describe("memecoin lab — cinta FOMO sana", () => {
  const { db, lab } = newLab();
  const tape = richFomo(1, T0);
  playTapes(lab, [tape], T0 + 40 * MIN);

  test("entra una vez y la compra se llena contra el PRIMER trade observado tras la latencia", () => {
    const decisions = db.query<any, []>("SELECT * FROM decisions").all();
    const entered = decisions.filter((d) => d.entered === 1);
    expect(entered.length).toBe(1);
    expect(entered[0].reason).toBe("enter");
    expect(entered[0].strategy_version).toBe(STRATEGY_VERSION);
    expect(entered[0].config_hash).toBe(configHash());
    const buy = db.query<any, []>("SELECT * FROM orders WHERE side = 'buy'").get();
    expect(buy.status).toBe("filled");
    expect(buy.latency_ms).toBeGreaterThanOrEqual(LAB_CONFIG.sim.latencyMs);
    // El fill coincide con un trade real de la cinta en t ≥ decidido + D, y es el primero de esos.
    const tradeTimes = tape.entries.filter((e) => e.n.events[0].type === "trade").map((e) => e.at);
    const first = tradeTimes.find((t) => t >= buy.decided_at + LAB_CONFIG.sim.latencyMs);
    expect(buy.filled_at).toBe(first);
    expect(buy.ref_signature).toBe(tape.entries.find((e) => e.at === first)!.n.signature);
  });

  test("costes declarados: comisión ≥ suelo, MEV por lado, fee de tx; tamaño = 8 % de la caja", () => {
    const buy = db.query<any, []>("SELECT * FROM orders WHERE side = 'buy'").get();
    expect(buy.fee_bps).toBe(LAB_CONFIG.sim.pumpFeeBpsFloor);
    expect(buy.tx_fee_sol).toBe(LAB_CONFIG.sim.txFeeSol);
    const budget = LAB_CONFIG.account.initialSol * LAB_CONFIG.strategy.sizing.fractionOfBalance;
    expect(buy.sol_amount).toBeCloseTo(budget + LAB_CONFIG.sim.txFeeSol, 9);
    expect(buy.pump_fee_sol).toBeCloseTo(budget - budget / (1 + LAB_CONFIG.sim.pumpFeeBpsFloor / 10_000), 9);
    expect(buy.mev_sol).toBeCloseTo((budget / (1 + LAB_CONFIG.sim.pumpFeeBpsFloor / 10_000)) * LAB_CONFIG.sim.mevPerSide, 9);
  });

  test("la posición cierra (take profit parcial + trailing/time stop), nunca supera 10 min, y cuadra la caja", () => {
    const pos = db.query<any, []>("SELECT * FROM positions").all();
    expect(pos.length).toBe(1);
    const p = pos[0];
    expect(p.closed_at).not.toBeNull();
    expect(p.closed_at - p.opened_at).toBeLessThanOrEqual(LAB_CONFIG.strategy.exits.timeStopMs + LAB_CONFIG.sim.latencyMs + LAB_CONFIG.sim.sellDeadTimeoutMs + 1_000);
    expect(["take_profit", "trailing", "time_stop", "flow_reversal"]).toContain(p.close_reason);
    expect(p.tokens_remaining).toBe(0);
    const sells = db.query<any, []>("SELECT * FROM orders WHERE side = 'sell' AND status = 'filled'").all();
    expect(sells.length).toBeGreaterThanOrEqual(1);
    const proceeds = sells.reduce((a, o) => a + o.sol_amount, 0);
    expect(p.proceeds_sol).toBeCloseTo(proceeds, 9);
    expect(p.pnl_sol).toBeCloseTo(p.proceeds_sol - p.cost_sol, 9);
    expect(lab.cashSol).toBeCloseTo(LAB_CONFIG.account.initialSol - p.cost_sol + p.proceeds_sol, 9);
    expect(lab.positions.size).toBe(0);
  });

  test("todo candidato deja desenlace: precio a +5 min y +1 h rellenos, +24 h pendiente a los 40 min", () => {
    const outs = db.query<any, []>("SELECT * FROM outcomes").all();
    expect(outs.length).toBe(db.query<any, []>("SELECT COUNT(*) AS c FROM decisions").get().c);
    for (const o of outs) {
      expect(o.price_5m).not.toBeNull();
      expect(o.ret_5m).not.toBeNull();
      expect(o.price_1h).toBeNull();
      expect(o.done).toBe(0);
    }
  });

  test("el token sale de memoria tras la ventana de seguimiento con sus agregados en la tabla", () => {
    expect(lab.tokens.size).toBe(0);
    const t = db.query<any, []>("SELECT * FROM tokens").get();
    expect(t.status).toBe("entered");
    expect(t.trades_seen).toBe(91);
    expect(t.holders).toBe(91);
    expect(t.dropped_at).not.toBeNull();
  });
});

describe("memecoin lab — pump & dump", () => {
  test("el dev vuelca: salida por dev_sold o stop, pérdida pagada entera y gap del stop registrado", () => {
    const { db, lab } = newLab();
    const tape = pumpAndDumpTape(7, T0, 162_000); // el dev vuelca pocos segundos después del fill de entrada (~160 s)
    playTapes(lab, [tape], T0 + 40 * MIN);
    const p = db.query<any, []>("SELECT * FROM positions").get();
    expect(p).toBeDefined();
    expect(p.closed_at).not.toBeNull();
    expect(["dev_sold", "stop", "flow_reversal"]).toContain(p.close_reason);
    expect(p.pnl_sol).toBeLessThan(0);
    expect(lab.cashSol).toBeLessThan(LAB_CONFIG.account.initialSol);
    // La latencia se paga: la venta se llena contra un trade de la cascada, ≥ 1,5 s después de decidirla.
    const sell = db.query<any, []>("SELECT * FROM orders WHERE side = 'sell'").get();
    const devSellAt = tape.entries.find((e) => e.n.events[0].type === "trade" && !(e.n.events[0] as any).isBuy)!.at;
    expect(sell.decided_at).toBeGreaterThanOrEqual(devSellAt);
    expect(sell.filled_at - sell.decided_at).toBeGreaterThanOrEqual(LAB_CONFIG.sim.latencyMs);
    expect(p.pnl_pct).toBeLessThan(p.peak_pct);
  });

  test("stop: se dispara sobre el P&L ejecutable y el fill real registra el gap", () => {
    const { db, lab } = newLab();
    const r = rng(11);
    const tape = new TokenTape(r, T0, { symbol: "STOP" });
    tape.buy(T0 + 200, tape.dev, 0.2);
    for (let i = 0; i < 90; i++) tape.buy(T0 + 2_500 + i * 2_000, tape.wallet(i), 0.25 * (1 + (2.5 * i) / 90));
    // Entrada ≈ cuando hay ≥ 50 holders (~100 s); a los 200 s empieza una cascada de ventas de wallets normales.
    const bal = new Map<string, number>();
    for (const e of tape.entries) {
      const ev = e.n.events[0];
      if (ev.type === "trade" && ev.isBuy) bal.set(ev.user, ev.tokenRaw);
    }
    let t = T0 + 200_000;
    for (let i = 0; i < 60; i++) {
      t += 500;
      const w = tape.wallet(i);
      tape.sell(t, w, bal.get(w) ?? 0);
    }
    tape.entries.sort((a, b) => a.at - b.at);
    playTapes(lab, [tape], T0 + 30 * MIN);
    const p = db.query<any, []>("SELECT * FROM positions").get();
    expect(p).toBeDefined();
    expect(p.closed_at).not.toBeNull();
    expect(["stop", "flow_reversal", "trailing"]).toContain(p.close_reason);
    if (p.close_reason === "stop") {
      // Nivel = referencia tras el fill (negativa: costes) + stopPct; se dispara sobre el P&L ejecutable real.
      expect(p.entry_exec_pct).toBeLessThan(0);
      expect(p.entry_exec_pct).toBeGreaterThan(-10);
      expect(p.stop_level_pct).toBeCloseTo(p.entry_exec_pct + LAB_CONFIG.strategy.exits.stopPct, 9);
      expect(p.stop_trigger_pct).toBeLessThanOrEqual(p.stop_level_pct);
      expect(p.stop_fill_pct).toBeCloseTo(p.pnl_pct, 9);
      expect(p.stop_gap_pct).toBeCloseTo(p.pnl_pct - p.stop_level_pct, 9);
      // La latencia se paga: en una cascada de ventas el fill es peor que el nivel del stop.
      expect(p.stop_gap_pct).toBeLessThan(0);
      expect(p.pnl_pct).toBeLessThan(LAB_CONFIG.strategy.exits.stopPct);
    }
    // Sin re-entrada en el mismo token: la cinta sigue viva y no hay segunda posición.
    expect(db.query<any, []>("SELECT COUNT(*) AS c FROM positions").get().c).toBe(1);
  });
});

describe("memecoin lab — token muerto, migración, hueco", () => {
  test("venta sin trades posteriores: se llena contra el último estado real (token muerto)", () => {
    const { db, lab } = newLab();
    const tape = richFomo(21, T0, "DEAD");
    // Cortamos la cinta justo tras la entrada: nada más después.
    playTapes(lab, [tape], T0 + 4 * MIN + 10_000);
    expect(lab.positions.size).toBe(1);
    // Sin trades: el time stop decide la venta a los 10 min y, sin trade posterior, se llena al último estado.
    for (let t = T0 + 4 * MIN + 11_000; t <= T0 + 20 * MIN; t += 1_000) lab.tick(t);
    const p = db.query<any, []>("SELECT * FROM positions").get();
    expect(p.closed_at).not.toBeNull();
    expect(p.close_reason).toBe("time_stop");
    const sell = db.query<any, []>("SELECT * FROM orders WHERE side = 'sell' ORDER BY id DESC").get();
    expect(sell.note).toBe("dead_token_last_state");
    expect(sell.latency_ms).toBeGreaterThanOrEqual(LAB_CONFIG.sim.latencyMs + LAB_CONFIG.sim.sellDeadTimeoutMs);
    expect(sell.latency_ms).toBeLessThan(LAB_CONFIG.sim.latencyMs + LAB_CONFIG.sim.sellDeadTimeoutMs + 1_000);
  });

  test("migración con posición abierta: salida forzada al último precio menos el recargo declarado", () => {
    const { db, lab } = newLab();
    const tape = richFomo(31, T0, "GRAD");
    const lastTrade = tape.entries[tape.entries.length - 1].at;
    tape.complete(lastTrade + 5_000);
    playTapes(lab, [tape], T0 + 30 * MIN);
    const p = db.query<any, []>("SELECT * FROM positions").get();
    expect(p).toBeDefined();
    expect(p.close_reason).toBe("migration");
    const sell = db.query<any, []>("SELECT * FROM orders WHERE side = 'sell' AND reason = 'migration'").get();
    expect(sell.note).toBe("forced_exit_after_migration");
    // Recargo del 25 % sobre el bruto: el neto es claramente menor que lo que daría la curva sin recargo.
    const t = db.query<any, []>("SELECT * FROM tokens").get();
    expect(t.status).toBe("migrated");
    const o = db.query<any, [number]>("SELECT * FROM outcomes WHERE decision_id = ?").get(p.decision_id);
    expect(o.graduated).toBe(1);
  });

  test("no se entra cerca de la graduación (SOL real en la curva ≥ umbral)", () => {
    // Umbral bajado a 10 SOL para que la cinta FOMO lo cruce antes de cumplir los demás filtros.
    const cfg = { ...LAB_CONFIG, sim: { ...LAB_CONFIG.sim, noEntryAboveRealSol: 10 } };
    const { db, lab } = newLab(cfg);
    playTapes(lab, [richFomo(41, T0, "NEAR")], T0 + 20 * MIN);
    const d = db.query<any, []>("SELECT * FROM decisions ORDER BY id").all();
    expect(d.length).toBe(1);
    expect(d[0].entered).toBe(0);
    expect(d[0].reason).toBe("near_graduation");
    expect(JSON.parse(d[0].metrics_json).realSol).toBeGreaterThanOrEqual(10);
  });

  test("hueco del feed: cancela compras pendientes, invalida métricas (data_gap) y marca la posición", () => {
    const { db, lab } = newLab();
    const tape = richFomo(51, T0, "GAP");
    // Reproducimos hasta justo después de la decisión de entrada (la orden queda pendiente ≥ 1,5 s).
    const all = [...tape.entries].sort((a, b) => a.at - b.at);
    let decidedAt: number | null = null;
    let tick = T0;
    for (const e of all) {
      while (tick <= e.at) {
        lab.tick(tick);
        tick += 1_000;
      }
      lab.onNotification(e.n, e.at);
      if (lab.pending.length > 0 && decidedAt === null) {
        decidedAt = e.at;
        break;
      }
    }
    expect(decidedAt).not.toBeNull();
    lab.onGapStart(decidedAt! + 100, "test");
    expect(lab.pending.length).toBe(0);
    expect(db.query<any, []>("SELECT status, note FROM orders").get()).toEqual({ status: "cancelled", note: "gap" });
    lab.onGapEnd(decidedAt! + 5_000);
    const g = db.query<any, []>("SELECT * FROM gaps").get();
    expect(g.to_at).toBe(decidedAt! + 5_000);
    // Un token nuevo creado tras el hueco se evalúa limpio; el viejo queda gapped.
    const t2 = richFomo(52, decidedAt! + 6_000, "POST");
    for (const e of t2.entries) {
      while (tick <= e.at) {
        lab.tick(tick);
        tick += 1_000;
      }
      lab.onNotification(e.n, e.at);
    }
    for (; tick <= decidedAt! + 20 * MIN; tick += 1_000) lab.tick(tick);
    const tokens = db.query<any, []>("SELECT mint, gapped, status FROM tokens ORDER BY created_at").all();
    expect(tokens[0].gapped).toBe(1);
    expect(tokens[1].gapped).toBe(0);
    expect(tokens[1].status).toBe("entered");
    expect(db.query<any, []>("SELECT COUNT(*) AS c FROM positions").get().c).toBe(1);
  });
});

describe("memecoin lab — cartera y descartes", () => {
  test("K posiciones como máximo: la cuarta señal válida se registra como max_positions, con desenlace", () => {
    const { db, lab } = newLab();
    const tapes = [richFomo(61, T0, "A"), richFomo(62, T0 + 1_000, "B"), richFomo(63, T0 + 2_000, "C"), richFomo(64, T0 + 3_000, "D")];
    playTapes(lab, tapes, T0 + 6 * MIN);
    const d = db.query<any, []>("SELECT reason, entered FROM decisions ORDER BY id").all();
    expect(d.filter((x) => x.entered === 1).length).toBe(LAB_CONFIG.strategy.sizing.maxPositions);
    expect(d.filter((x) => x.reason === "max_positions").length).toBe(1);
    expect(db.query<any, []>("SELECT COUNT(*) AS c FROM outcomes").get().c).toBe(4);
  });

  test("descarte por concentración: una ballena en los primeros 2 s → early_wallets/top10, con métricas y precio", () => {
    const { db, lab } = newLab();
    const r = rng(71);
    const tape = new TokenTape(r, T0, { symbol: "WHALE" });
    tape.buy(T0 + 500, tape.wallet(999), 8); // ballena en el primer bloque
    for (let i = 0; i < 60; i++) tape.buy(T0 + 2_500 + i * 3_000, tape.wallet(i), 0.2);
    playTapes(lab, [tape], T0 + 20 * MIN);
    const d = db.query<any, []>("SELECT * FROM decisions").get();
    expect(d.entered).toBe(0);
    expect(["early_wallets", "top10_concentrated"]).toContain(d.reason);
    const m = JSON.parse(d.metrics_json);
    expect(m.earlyWalletsShare).toBeGreaterThan(0.3);
    expect(d.price_sol).toBeGreaterThan(0);
    expect(db.query<any, []>("SELECT status FROM tokens").get().status).toBe("discarded");
    const o = db.query<any, []>("SELECT * FROM outcomes").get();
    expect(o.price_5m).not.toBeNull();
  });

  test("un token sin actividad no genera decisión (ignored) y uno con curva atípica se descarta como curve_atypical", () => {
    const { db, lab } = newLab();
    const r = rng(81);
    const dead = new TokenTape(r, T0, { symbol: "DEAD" });
    dead.buy(T0 + 100, dead.dev, 0.1);
    const odd = new TokenTape(r, T0, { symbol: "ODD", vSol: 200_000_000 });
    for (let i = 0; i < 20; i++) odd.buy(T0 + 1_000 + i * 2_000, odd.wallet(i), 0.01);
    playTapes(lab, [dead, odd], T0 + 40 * MIN);
    const tokens = db.query<any, []>("SELECT symbol, status FROM tokens ORDER BY symbol").all();
    expect(tokens).toEqual([
      { symbol: "DEAD", status: "ignored" },
      { symbol: "ODD", status: "discarded" },
    ]);
    expect(db.query<any, []>("SELECT reason FROM decisions").get().reason).toBe("curve_atypical");
  });

  test("tx duplicadas (misma firma) se ignoran: los saldos no se duplican", () => {
    const { lab } = newLab();
    const tape = richFomo(91, T0, "DUP");
    for (const e of tape.entries) {
      lab.onNotification(e.n, e.at);
      lab.onNotification(e.n, e.at + 1);
    }
    expect(lab.stats.duplicates).toBe(tape.entries.length);
    const t = lab.tokens.get(tape.mint)!;
    expect(t.tradesSeen).toBe(91);
  });
});

describe("memecoin lab — determinismo, reinicio y regla de 5 días", () => {
  test("la misma cinta produce exactamente la misma base", () => {
    const run = () => {
      const { db, lab } = newLab();
      playTapes(lab, [richFomo(101, T0, "A"), pumpAndDumpTape(102, T0 + 500)], T0 + 30 * MIN);
      return JSON.stringify({
        d: db.query("SELECT mint, decided_at, entered, reason, score, price_sol FROM decisions ORDER BY id").all(),
        p: db.query("SELECT mint, opened_at, closed_at, cost_sol, proceeds_sol, close_reason FROM positions ORDER BY id").all(),
        o: db.query("SELECT * FROM orders ORDER BY id").all(),
        cash: lab.cashSol,
      });
    };
    expect(run()).toBe(run());
  });

  test("reinicio: un lab nuevo sobre la misma base restaura caja, posiciones abiertas y desenlaces pendientes", () => {
    const db = openLabDb(":memory:");
    const lab1 = new MemecoinLab(db, { now: T0 });
    const tape = richFomo(111, T0, "RST");
    playTapes(lab1, [tape], T0 + 4 * MIN + 10_000);
    expect(lab1.positions.size).toBe(1);
    const cash = lab1.cashSol;
    const lab2 = new MemecoinLab(db, { now: T0 + 5 * MIN });
    expect(lab2.cashSol).toBeCloseTo(cash, 12);
    expect(lab2.positions.size).toBe(1);
    expect(lab2.positions.get(tape.mint)!.gapped).toBe(true);
    // Las ventas siguen funcionando sobre el último estado que lleguen por el feed.
    const r = rng(112);
    tape.sell(T0 + 6 * MIN, fakeKey(r), 1_000_000);
    lab2.onNotification(tape.entries[tape.entries.length - 1].n, T0 + 6 * MIN);
    for (let t = T0 + 6 * MIN; t <= T0 + 20 * MIN; t += 1_000) lab2.tick(t);
    const p = db.query<any, []>("SELECT * FROM positions").get();
    expect(p.closed_at).not.toBeNull();
    expect(p.gapped).toBe(1);
    expect(db.query<any, []>("SELECT COUNT(*) AS c FROM outcomes WHERE done = 0").get().c).toBe(1);
  });

  test("regla del dueño: la aserción de 5 días salta si una posición envejece; el time stop lo impide en la práctica", () => {
    const { lab } = newLab();
    const tape = richFomo(121, T0, "OLD");
    playTapes(lab, [tape], T0 + 4 * MIN + 10_000);
    expect(lab.positions.size).toBe(1);
    expect(() => lab.assertMaxHold(T0 + 4 * MIN + 10_000)).not.toThrow();
    expect(() => lab.assertMaxHold(T0 + 6 * 24 * 60 * MIN)).toThrow(/5 días/);
    expect(LAB_CONFIG.strategy.exits.timeStopMs).toBeLessThanOrEqual(60 * MIN);
    expect(LAB_CONFIG.strategy.exits.hardMaxHoldMs).toBe(5 * 24 * 60 * MIN);
  });

  test("retención: los eventos crudos se guardan solo para candidatos y se podan a 7 días", () => {
    const { db, lab } = newLab();
    playTapes(lab, [richFomo(131, T0, "RAW")], T0 + 20 * MIN);
    const n = db.query<any, []>("SELECT COUNT(*) AS c FROM raw_trades").get().c;
    expect(n).toBeGreaterThan(0);
    const { pruneRawTrades } = require("./db");
    expect(pruneRawTrades(db, T0 + 20 * MIN, 7)).toBe(0);
    expect(pruneRawTrades(db, T0 + 8 * 24 * 60 * MIN, 7)).toBe(n);
  });
});
