/**
 * Decodificador contra logs REALES del programa pump.fun capturados el
 * 2026-11-10 (datos públicos on-chain; ver fixtures/). Sin red.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { base58Encode, DISCRIMINATORS, extractEvents, parseFrame, SignatureDeduper, type CreateEvent, type TradeEvent } from "./decoder";
import { PUMP_PROGRAM_ID } from "./config";
import { spotPrice } from "./curve";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pump-logs-2026-11-10.json"), "utf-8")) as {
  program: string;
  rawFrames: string[];
  notifications: { kind: string; slot: number; value: { signature: string; err: unknown; logs: string[] } }[];
};

describe("memecoin lab — decoder (fixture real)", () => {
  test("el fixture es del programa pump.fun y contiene cada clase de transacción", () => {
    expect(fixture.program).toBe(PUMP_PROGRAM_ID);
    const kinds = new Set(fixture.notifications.map((n) => n.kind));
    expect(kinds).toContain("trade");
    expect(kinds).toContain("create");
    expect(kinds).toContain("failed");
    expect(kinds).toContain("plain");
  });

  test("discriminadores Anchor conocidos", () => {
    expect(DISCRIMINATORS.trade).toBe("bddb7fd34ee661ee");
    expect(DISCRIMINATORS.create).toBe("1b72a94ddeeb6376");
    expect(DISCRIMINATORS.complete).toBe("5f72619cd42e9808");
  });

  test("base58: el programa pump.fun y vectores conocidos", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58Encode(new Uint8Array([0]))).toBe("1");
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array(32))).toBe("1".repeat(32));
    // Vector conocido: "hello" → "Cn8eVZg".
    expect(base58Encode(new TextEncoder().encode("hello"))).toBe("Cn8eVZg");
    // Claves del CreateEvent: base58 válido de longitud de pubkey (prueba de ida completa sobre datos reales).
    const creates = fixture.notifications.filter((n) => n.kind === "create");
    for (const n of creates) {
      const ev = extractEvents(n.value.logs).find((e) => e.type === "create") as CreateEvent;
      expect(ev.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(ev.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  test("TradeEvent: reservas coherentes, precio = vSol/vTok, fees cuando vienen", () => {
    const trades = fixture.notifications.filter((n) => n.kind === "trade");
    expect(trades.length).toBeGreaterThanOrEqual(20);
    let withFees = 0;
    for (const n of trades) {
      const evs = extractEvents(n.value.logs).filter((e): e is TradeEvent => e.type === "trade");
      expect(evs.length).toBeGreaterThan(0);
      for (const t of evs) {
        expect(t.mint.length).toBeGreaterThanOrEqual(32);
        expect(t.user.length).toBeGreaterThanOrEqual(32);
        // Hay curvas con vSol minúsculo (quote distinto de SOL vía router): el lab las filtra por `minInitialVSol`,
        // el decodificador solo exige coherencia.
        expect(t.vSol).toBeGreaterThan(0);
        expect(t.vTok).toBeGreaterThan(1e12);
        expect(t.rTok).toBeLessThanOrEqual(t.vTok);
        expect(t.rSol).toBeLessThanOrEqual(t.vSol);
        expect(t.timestamp).toBeGreaterThan(1_700_000_000);
        expect(t.timestamp).toBeLessThan(2_000_000_000);
        const p = spotPrice({ vSol: t.vSol, vTok: t.vTok });
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1e-4);
        if (t.feeBps !== null) {
          withFees++;
          expect(t.feeBps).toBeGreaterThanOrEqual(0);
          expect(t.feeBps).toBeLessThanOrEqual(1_000);
          // fee observada ≈ sol × bps (tolerancia por redondeos del programa); los casos a 0 pb traen fee 0.
          if (t.feeBps > 0 && t.solLamports > 0) {
            const expected = (t.solLamports * t.feeBps) / 10_000;
            expect(Math.abs((t.feeLamports ?? 0) - expected)).toBeLessThanOrEqual(expected * 0.05 + 10);
          }
        }
      }
    }
    expect(withFees).toBeGreaterThan(0);
  });

  test("CreateEvent: strings + claves + reservas iniciales (se leen por token, no se hardcodean)", () => {
    const creates = fixture.notifications.filter((n) => n.kind === "create");
    expect(creates.length).toBeGreaterThanOrEqual(3);
    for (const n of creates) {
      const ev = extractEvents(n.value.logs).find((e) => e.type === "create") as CreateEvent;
      expect(ev).toBeDefined();
      expect(ev.name.length).toBeGreaterThan(0);
      expect(ev.symbol.length).toBeGreaterThan(0);
      expect(ev.uri.startsWith("http") || ev.uri.startsWith("ipfs")).toBe(true);
      expect(ev.bondingCurve.length).toBeGreaterThanOrEqual(32);
      expect(ev.user.length).toBeGreaterThanOrEqual(32);
      expect(ev.creator.length).toBeGreaterThanOrEqual(32);
      expect(ev.vSol).toBeGreaterThan(1e9);
      expect(ev.vTok).toBeGreaterThan(1e14);
      expect(ev.totalSupply).toBeGreaterThan(ev.rTok);
      expect(ev.timestamp).toBeGreaterThan(1_700_000_000);
    }
  });

  test("una tx fallida se descarta por el frame crudo, antes del JSON.parse", () => {
    const failed = fixture.rawFrames.filter((f) => !f.includes('"err":null'));
    const ok = fixture.rawFrames.filter((f) => f.includes('"err":null'));
    expect(failed.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);
    for (const f of failed) expect(parseFrame(f)).toEqual({ kind: "skip", reason: "failed_tx" });
    for (const f of ok) {
      const p = parseFrame(f);
      expect(["notification", "skip"]).toContain(p.kind);
      if (p.kind === "notification") {
        expect(p.slot).toBeGreaterThan(0);
        expect(p.signature.length).toBeGreaterThan(40);
      }
    }
  });

  test("notificaciones reconstruidas: fallidas → skip, sin eventos → skip, con eventos → notification", () => {
    for (const n of fixture.notifications) {
      const raw = JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: { context: { slot: n.slot }, value: n.value }, subscription: 1 } });
      const p = parseFrame(raw);
      if (n.kind === "failed") expect(p).toEqual({ kind: "skip", reason: "failed_tx" });
      else if (n.kind === "plain") expect(p).toEqual({ kind: "skip", reason: "no_events" });
      else {
        expect(p.kind).toBe("notification");
        if (p.kind === "notification") expect(p.events.some((e) => e.type === n.kind)).toBe(true);
      }
    }
  });

  test("el RPC repite transacciones (misma firma): el deduplicador deja pasar cada firma una sola vez", () => {
    const sigs = fixture.notifications.map((n) => n.value.signature);
    const distinct = new Set(sigs).size;
    expect(distinct).toBeLessThan(sigs.length); // el fixture real contiene duplicados
    const d = new SignatureDeduper(1_000);
    const admitted = sigs.filter((s) => d.admit(s));
    expect(admitted.length).toBe(distinct);
    expect(d.size).toBe(distinct);
    // Capacidad acotada: nunca crece sin límite.
    const small = new SignatureDeduper(3);
    for (const s of ["a", "b", "c", "d"]) small.admit(s);
    expect(small.size).toBe(3);
    expect(small.admit("a")).toBe(true); // expulsada por FIFO, vuelve a admitirse
  });

  test("frames de control y basura", () => {
    expect(parseFrame('{"jsonrpc":"2.0","result":123,"id":1}')).toEqual({ kind: "control", id: 1, result: 123, error: undefined });
    expect(parseFrame("not json").kind).toBe("skip");
    expect(parseFrame('{"jsonrpc":"2.0","method":"other","params":{}}')).toEqual({ kind: "skip", reason: "not_notification" });
  });
});
