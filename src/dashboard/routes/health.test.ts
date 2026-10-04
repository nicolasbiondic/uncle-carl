import express from "express";
import { describe, expect, test } from "bun:test";
import { registerHealthRoutes } from "./health";
import { makeTestDb } from "../../test-support/db";
import { sessions } from "../auth-store";
import { _resetPublishedManifestForTests, publishInstanceManifest } from "../../ops/instanceManifest";
import { SleeveGovernor, _resetLastConstructedSleeveGovernorForTests } from "../../governor/SleeveGovernor";

const am = {
  lastSyncAt: 0,
  accounts: new Map(),
  executor: {
    alpaca: { isConnected: () => false, lastMessageAt: 0 },
    binance: { isConnected: () => false, lastMessageAt: 0 },
  },
  getCircuits: () => ({}),
} as any;

async function getHealthz() {
  makeTestDb();
  const app = express();
  registerHealthRoutes(app, am);
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    return { status: res.status, body: await res.json() as any };
  } finally {
    server.close();
  }
}

describe("GET /healthz — public endpoint", () => {
  test("includes a runtime commit identifier", async () => {
    const { body } = await getHealthz();
    expect(typeof body.commit).toBe("string");
    expect(body.commit.length).toBeGreaterThan(0);
    expect("dirty" in body).toBe(true);
    expect(typeof body.started_at).toBe("string");
  });

  test("does NOT leak positions, equity, or pnl — the /healthz vs /healthz/full boundary", async () => {
    const { body } = await getHealthz();
    const keys = Object.keys(body);
    // Only the public-safe shape: status/version/commit/dirty/started_at/
    // uptime — none of the /healthz/full-only fields (positions, equity,
    // brokers, db size, sleeve modes, invariants...).
    for (const forbidden of [
      "open_positions", "equity", "pnl", "brokers", "db_size_mb",
      "sleeve_modes", "invariants", "profiles", "last_sync_ago_seconds", "engine",
      "manifest", // instance manifest (flags/hostname/fingerprints) is /healthz/full-only
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("GET /healthz/full — instance manifest exposure", () => {
  async function getHealthzFull(headers: Record<string, string> = {}) {
    makeTestDb();
    const app = express();
    registerHealthRoutes(app, am);
    const server = app.listen(0);
    try {
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz/full`, { headers });
      return { status: res.status, body: await res.json() as any };
    } finally {
      server.close();
    }
  }

  test("unauthenticated ⇒ 401, no manifest", async () => {
    _resetPublishedManifestForTests();
    const { status, body } = await getHealthzFull();
    expect(status).toBe(401);
    expect(body.manifest).toBeUndefined();
  });

  test("authenticated ⇒ serves the published manifest (flags + broker fingerprints)", async () => {
    _resetPublishedManifestForTests();
    const sid = "test-sid-health-manifest";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    } as any);
    try {
      makeTestDb(); // manifest publication touches sync_state via the swap guard
      await publishInstanceManifest({ env: {}, dotenvValues: {}, hostname: "testhost" });
      const { body } = await getHealthzFull({ "x-session-id": sid });
      expect(body.manifest).toBeDefined();
      expect(body.manifest.hostname).toBe("testhost");
      expect(body.manifest.flags.TRADING_ENABLED).toBeDefined();
      expect(body.manifest.broker_identities).toBeDefined();
    } finally {
      sessions.delete(sid);
      _resetPublishedManifestForTests();
    }
  });
});

describe("GET /healthz/full — sleeveModes (registered kind vs effective/overridden mode)", () => {
  test("a sleeve_modes row overriding a registered default shows BOTH — effectiveMode wins", async () => {
    makeTestDb();
    _resetLastConstructedSleeveGovernorForTests();
    // index.ts registers momentum_crypto shadow by default (docs.test.ts
    // enforces this against README). The owner later hand-overrode it to
    // live via scripts/set-sleeve-mode.ts (sleeve_modes row) — 2026-08-08 in
    // prod. Reproduce both halves here: register() seeds the DEFAULT row,
    // setMode() simulates the owner's later manual override.
    const governor = new SleeveGovernor();
    governor.register({ sleeve: "momentum_crypto", kind: "shadow" });
    governor.setMode("momentum_crypto", "live", "owner override 2026-08-08");

    const app = express();
    registerHealthRoutes(app, am);
    const server = app.listen(0);
    const sid = "test-sid-health-sleeve-modes";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    } as any);
    try {
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz/full`, { headers: { "x-session-id": sid } });
      const body = await res.json() as any;
      expect(Array.isArray(body.sleeveModes)).toBe(true);
      const row = body.sleeveModes.find((r: any) => r.sleeve === "momentum_crypto");
      expect(row).toBeDefined();
      expect(row.registeredKind).toBe("shadow");
      expect(row.effectiveMode).toBe("live");
      expect(row.reason).toBe("owner override 2026-08-08");
      expect(typeof row.updatedAt).toBe("number");
    } finally {
      sessions.delete(sid);
      server.close();
      _resetLastConstructedSleeveGovernorForTests();
    }
  });
});

// ── Broker unreachable ≠ dead (2026-09-25, the watchdog-vs-broker class) ──
// A loop that keeps COMPLETING passes against an unreachable broker
// (heartbeats.beatFailed) must keep /healthz at 200 — watchdog.sh restarts
// on any non-200, and a restart cannot cure a broker outage (09-23 07:45
// restarted a healthy process into "DEGRADED START — alpaca DOWN").
// /healthz/full exposes the per-venue reachability instead.
describe("broker unreachable ≠ dead loop (watchdog must not restart)", () => {
  const { heartbeats } = require("../../ops/heartbeat");

  function simulateOutage(loop: string) {
    heartbeats.register(loop, 60_000);
    heartbeats.beatFailed(loop); // fresh liveness beat
    // Backdate the last SUCCESS past the episode threshold and accumulate
    // failures — same reach-into-the-singleton idiom as server.test.ts's
    // dead-loop test (process singleton on Date.now, no clock seam).
    const b = (heartbeats as any).beats.get(loop);
    b.lastSuccessMs = Date.now() - 6 * 60_000;
    b.consecutiveFailures = 5;
  }
  function clearOutage(loop: string) {
    heartbeats.beat(loop);
    heartbeats.register(loop, 10 * 60_000); // wide → can't go stale later in the suite
  }

  test("/healthz stays 200 'degraded' with broker_unreachable_count — never 503 for a broker outage", async () => {
    makeTestDb();
    simulateOutage("sync_alpaca");
    const app = express();
    registerHealthRoutes(app, am);
    const server = app.listen(0);
    try {
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(res.status).toBe(200); // the whole point: watchdog sees UP
      const body = await res.json() as any;
      expect(body.status).toBe("degraded");
      expect(body.broker_unreachable_count).toBe(1);
      // Liveness is fresh (beatFailed) → not stale, not dead.
      expect(body.stale_loop_count).toBeUndefined();
    } finally {
      clearOutage("sync_alpaca");
      server.close();
    }
  });

  test("/healthz/full maps venue → reachability (alpaca down, binance fine)", async () => {
    makeTestDb();
    simulateOutage("sync_alpaca");
    heartbeats.register("sync_binance", 60_000);
    heartbeats.beat("sync_binance");
    const app = express();
    registerHealthRoutes(app, am);
    const server = app.listen(0);
    const sid = "test-sid-health-broker-unreachable";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    } as any);
    try {
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz/full`, { headers: { "x-session-id": sid } });
      const body = await res.json() as any;
      expect(body.broker_unreachable.alpaca.unreachable).toBe(true);
      expect(body.broker_unreachable.alpaca.consecutive_failures).toBe(5);
      expect(body.broker_unreachable.alpaca.last_success_ago_seconds).toBeGreaterThanOrEqual(360);
      expect(body.broker_unreachable.binance_usdm.unreachable).toBe(false);
    } finally {
      sessions.delete(sid);
      clearOutage("sync_alpaca");
      heartbeats.register("sync_binance", 10 * 60_000);
      server.close();
    }
  });

  test("recovery flips the flag back without a restart", async () => {
    makeTestDb();
    simulateOutage("sync_binance_usdc");
    heartbeats.beat("sync_binance_usdc"); // broker back → one success resets the episode
    const app = express();
    registerHealthRoutes(app, am);
    const server = app.listen(0);
    try {
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).broker_unreachable_count).toBeUndefined();
    } finally {
      heartbeats.register("sync_binance_usdc", 10 * 60_000);
      server.close();
    }
  });
});
