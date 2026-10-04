// ══════════════════════════════════════════════
// panic.ts — broker-side kill switch operator tool, guardrail tests
// ══════════════════════════════════════════════
//
// Exercises the exported client-injected functions directly (no subprocess,
// no stdin, no network) — same pattern as set-sleeve-mode.test.ts. The
// guardrails under test: idempotency (no PATCH when already in the desired
// state), write-then-verify (never trust the PATCH response alone),
// confirmation policy (resuming must be hard to fat-finger), audit trail.

import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState, applySuspend, confirmAnswerAccepted, appendPanicAudit, parseArgs,
  type PanicClient,
} from "./panic";

function fakeClient(state: { suspend_trade: boolean }): PanicClient & { updateAccountConfigurations: ReturnType<typeof mock> } {
  return {
    getAccount: mock(async () => ({ id: "acc-1", trade_suspended_by_user: state.suspend_trade })),
    getAccountConfigurations: mock(async () => ({ suspend_trade: state.suspend_trade })),
    updateAccountConfigurations: mock(async (cfg: Record<string, unknown>) => {
      state.suspend_trade = Boolean(cfg.suspend_trade);
      return { suspend_trade: state.suspend_trade };
    }),
  };
}

describe("readState", () => {
  test("reads both the writable config and the account-side flag", async () => {
    const client = fakeClient({ suspend_trade: true });
    const s = await readState(client);
    expect(s).toEqual({ accountId: "acc-1", tradeSuspendedByUser: true, suspendTrade: true });
  });

  test("missing/malformed fields surface as null (unknown), never as a boolean guess", async () => {
    const client = {
      getAccount: async () => ({ id: "acc-1" }),
      getAccountConfigurations: async () => ({ suspend_trade: "yes" }), // non-boolean
      updateAccountConfigurations: async () => ({}),
    };
    const s = await readState(client);
    expect(s.tradeSuspendedByUser).toBeNull();
    expect(s.suspendTrade).toBeNull();
  });
});

describe("applySuspend", () => {
  test("activating is IDEMPOTENT: already suspended → no PATCH is ever sent", async () => {
    const client = fakeClient({ suspend_trade: true });
    const result = await applySuspend(client, true);
    expect(result.changed).toBe(false);
    expect(result.confirmed).toBe(true);
    expect(client.updateAccountConfigurations).not.toHaveBeenCalled();
  });

  test("deactivating is idempotent too", async () => {
    const client = fakeClient({ suspend_trade: false });
    const result = await applySuspend(client, false);
    expect(result.changed).toBe(false);
    expect(client.updateAccountConfigurations).not.toHaveBeenCalled();
  });

  test("a real change PATCHes { suspend_trade } and re-reads to confirm", async () => {
    const client = fakeClient({ suspend_trade: false });
    const result = await applySuspend(client, true);
    expect(client.updateAccountConfigurations).toHaveBeenCalledWith({ suspend_trade: true });
    expect(result.changed).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(result.before.suspendTrade).toBe(false);
    expect(result.after.suspendTrade).toBe(true);
  });

  test("write-then-verify: a PATCH the broker silently ignored is reported UNCONFIRMED", async () => {
    const client = {
      getAccount: async () => ({ id: "acc-1", trade_suspended_by_user: false }),
      getAccountConfigurations: async () => ({ suspend_trade: false }), // never flips
      updateAccountConfigurations: mock(async () => ({})),
    };
    const result = await applySuspend(client, true);
    expect(result.changed).toBe(true);
    expect(result.confirmed).toBe(false); // caller exits non-zero and says "verify manually"
  });
});

describe("confirmAnswerAccepted — resuming must be hard to fat-finger", () => {
  test("panic (on) accepts y / yes", () => {
    expect(confirmAnswerAccepted("on", "y")).toBe(true);
    expect(confirmAnswerAccepted("on", "YES")).toBe(true);
    expect(confirmAnswerAccepted("on", "")).toBe(false);
    expect(confirmAnswerAccepted("on", "n")).toBe(false);
  });

  test("resume (off) ONLY accepts the literal word resume — never y/yes/enter", () => {
    expect(confirmAnswerAccepted("off", "resume")).toBe(true);
    expect(confirmAnswerAccepted("off", "  Resume ")).toBe(true);
    expect(confirmAnswerAccepted("off", "y")).toBe(false);
    expect(confirmAnswerAccepted("off", "yes")).toBe(false);
    expect(confirmAnswerAccepted("off", "")).toBe(false);
  });
});

describe("appendPanicAudit", () => {
  test("appends timestamped lines, creating the directory if needed", () => {
    const file = join(mkdtempSync(join(tmpdir(), "panic-audit-")), "nested", "panic.log");
    expect(existsSync(file)).toBe(false);
    appendPanicAudit("panic on: suspend_trade false → true", file);
    appendPanicAudit("panic off: suspend_trade true → false", file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*panic on: suspend_trade false → true$/);
    expect(lines[1]).toContain("panic off");
  });
});

describe("parseArgs", () => {
  test("default action is status (read-only)", () => {
    expect(parseArgs([])).toEqual({ action: "status", yes: false });
  });
  test("on/off with --yes", () => {
    expect(parseArgs(["on", "--yes"])).toEqual({ action: "on", yes: true });
    expect(parseArgs(["off"])).toEqual({ action: "off", yes: false });
  });
  test("unknown flags and actions are hard errors — never silently a write", () => {
    expect("error" in parseArgs(["--force"])).toBe(true);
    expect("error" in parseArgs(["onn"])).toBe(true);
    expect("error" in parseArgs(["on", "off"])).toBe(true);
  });
});
