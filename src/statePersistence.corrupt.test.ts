// fileStatePersistence corrupt-state quarantine (OPEN.md P2 2026-08-29):
// an unreadable state file (torn write, full disk) used to degrade to
// log.warn + null — indistinguishable from a fresh install, so RiskGuard
// silently re-anchored peakEquity at the BOTTOM of a drawdown and an active
// pause vanished, and a warn never pages (the burst tracker only counts
// ERROR). Now: the corrupt file is quarantined to `<path>.corrupt-<ts>`
// (post-mortem evidence; the next boot won't re-fail on it) and an
// ERROR_BURST pages ops. A genuinely missing file stays the quiet
// fresh-install path.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
// The repo's stale @types/node lacks rmSync (same workaround as telegram/outbox.test.ts).
const { rmSync } = require("fs") as { rmSync: (p: string, o?: any) => void };
import { tmpdir } from "os";
import { join } from "path";
import { fileStatePersistence } from "./index";
import { EQUITY_SEMANTICS } from "./strategies/momentum/RiskGuard";
import { captureBursts } from "./test-support/events";

let dir: string;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "uc-state-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { for (const f of readdirSync(dir)) { try { unlinkSync(join(dir, f)); } catch {} } });

function store(path: string) {
  return fileStatePersistence(path, 50_000, 50_000, EQUITY_SEMANTICS.SLEEVE_LEDGER);
}

describe("fileStatePersistence.load() corrupt-state quarantine", () => {
  test("garbage JSON → null + file renamed to <path>.corrupt-<ts> + ERROR_BURST(StatePersistence) emitted", () => {
    const path = join(dir, "momentum-state-stocks.json");
    writeFileSync(path, "{ this is not json !!!");
    const cap = captureBursts("StatePersistence");
    try {
      const loaded = store(path).load();
      expect(loaded).toBeNull();                       // engine still boots (fresh state)
      expect(existsSync(path)).toBe(false);            // original quarantined away
      const corrupt = readdirSync(dir).filter(f => /^momentum-state-stocks\.json\.corrupt-\d+$/.test(f));
      expect(corrupt).toHaveLength(1);
      // Evidence preserved byte-for-byte for the post-mortem.
      expect(readFileSync(join(dir, corrupt[0]), "utf-8")).toBe("{ this is not json !!!");
      expect(cap.bursts).toHaveLength(1);
      expect(cap.bursts[0].context).toBe("StatePersistence");
      expect(String(cap.bursts[0].message)).toContain(path);
      expect(String(cap.bursts[0].message)).toContain("corrupt");
    } finally { cap.detach(); }
  });

  test("missing file (fresh install) stays the quiet path: null, no quarantine, no page", () => {
    const path = join(dir, "never-existed.json");
    const cap = captureBursts("StatePersistence");
    try {
      expect(store(path).load()).toBeNull();
      expect(readdirSync(dir)).toHaveLength(0);        // nothing created or renamed
      expect(cap.bursts).toHaveLength(0);
    } finally { cap.detach(); }
  });

  test("a healthy envelope still loads (quarantine path untouched for valid files)", () => {
    const path = join(dir, "healthy.json");
    const s = store(path);
    // Round-trip through the real save() → the exact on-disk v1 envelope.
    s.save({
      v: 1,
      risk: { stateVersion: 3, equityBase: 50_000, pausedUntil: 0, pauseReason: "", peakEquity: 50_000 } as any,
      trailMarks: { "NVDA|buy": { mark: 1200, lastTs: 42 } },
    });
    const cap = captureBursts("StatePersistence");
    try {
      const loaded = s.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.trailMarks).toEqual({ "NVDA|buy": { mark: 1200, lastTs: 42 } });
      expect(existsSync(path)).toBe(true);
      expect(cap.bursts).toHaveLength(0);
    } finally { cap.detach(); }
  });
});
