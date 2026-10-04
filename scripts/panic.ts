#!/usr/bin/env bun
// ══════════════════════════════════════════════
// panic.ts — BROKER-enforced kill switch for the Alpaca account (2026-08-09)
// ══════════════════════════════════════════════
//
// Motivation (audit): every prior "stop trading" switch lived INSIDE one
// process — TRADING_ENABLED (env), RiskEngine HALTED/REDUCING (DB), governor
// modes (DB). A zombie process, a clone with a different .env, or an old code
// version ignores all of them (that is exactly the two-deployments-sharing-
// credentials incident). Alpaca's `suspend_trade` account configuration is
// the fix: it lives AT THE BROKER, so every process sharing the credentials
// is forced to respect it — while suspended, Alpaca rejects every NEW order
// submission account-wide.
//
// API surface (verified against the SDK we already ship,
// node_modules/@alpacahq/alpaca-trade-api/dist/resources/account.js +
// dist/alpaca-trade-api.js):
//   - write: client.updateAccountConfigurations({ suspend_trade: bool })
//            → PATCH /v2/account/configurations
//   - read:  client.getAccountConfigurations().suspend_trade
//            and GET /v2/account → trade_suspended_by_user
//
// What suspension does and does not do (Alpaca documented semantics):
//   - blocks ALL new order submissions — including the bot's own closes and
//     new protective stops. The bot keeps running: its close/stop loops
//     retry and resume the moment the switch is lifted; reconciliation is
//     read-only and unaffected. AlpacaExecutor additionally blocks its own
//     entry path bot-side (placeOrder) so it converges instead of hammering.
//   - does NOT cancel orders already on the books: existing uc8 GTC
//     protective stops keep working. That is why this is safe as a panic
//     switch.
//
// BINANCE (investigated 2026-08-09, official binance org connector
// binance-futures-connector-python/binance/um_futures/account.py — the full
// UM-futures signed surface): there is NO API-settable equivalent — no
// account-level "suspend trading" endpoint exists on /fapi/*. Explicitly
// DISCARDED: /fapi/v1/countdownCancelAll ("dead-man switch") — it CANCELS
// all open orders when the countdown lapses, i.e. it would remove our
// protective stops, the opposite of a kill switch. Realistic substitute:
// revoke/rotate the Binance API key (or uncheck "Enable Futures") in the
// web UI — a dead key blocks every order from every process instantly, and
// exchange-held stop orders remain on the books. This script prints that
// reminder; it cannot automate it.
//
// Guardrails:
//   (a) interactive confirmation unless --yes; resuming requires typing the
//       word "resume" (deliberately harder than y/N).
//   (b) shows the CURRENT broker state before changing anything.
//   (c) audit trail: appends to logs/panic.log.
//   (d) idempotent — already-in-desired-state is a no-op that says so.
//   (e) refuses an incoherent paper/live config (alpacaPaperLiveMismatch,
//       same guard the executor uses) and placeholder keys.
//
// Usage (also via ./start.sh panic / ./start.sh resume-trading):
//   bun scripts/panic.ts status          # show broker-side state, change nothing
//   bun scripts/panic.ts on   [--yes]    # SUSPEND all new orders at the broker
//   bun scripts/panic.ts off  [--yes]    # resume (asks you to type "resume")

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { config } from "../src/config";
import { alpacaPaperLiveMismatch } from "../src/executor/alpaca-executor";

// The minimal client surface this script needs — satisfied by the real SDK
// instance and by test fakes.
export interface PanicClient {
  getAccount(): Promise<any>;
  getAccountConfigurations(): Promise<any>;
  updateAccountConfigurations(cfg: Record<string, unknown>): Promise<any>;
}

export interface PanicState {
  accountId: string | null;
  /** GET /v2/account → trade_suspended_by_user (what the bot reads). */
  tradeSuspendedByUser: boolean | null;
  /** GET /v2/account/configurations → suspend_trade (what we write). */
  suspendTrade: boolean | null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Read both sides of the switch. Throws on network failure — this script
 *  must never guess broker state before writing it. */
export async function readState(client: PanicClient): Promise<PanicState> {
  const [account, configs] = await Promise.all([
    client.getAccount(),
    client.getAccountConfigurations(),
  ]);
  return {
    accountId: account?.id ? String(account.id) : null,
    tradeSuspendedByUser: asBool(account?.trade_suspended_by_user),
    suspendTrade: asBool(configs?.suspend_trade),
  };
}

export interface ApplyResult {
  /** false = already in the desired state (idempotent no-op). */
  changed: boolean;
  /** true = the post-write re-read confirms the desired state. */
  confirmed: boolean;
  before: PanicState;
  after: PanicState;
}

/** Idempotent write: PATCH only when the broker's current `suspend_trade`
 *  differs from `desired`, then RE-READ to confirm — never trust the PATCH
 *  response alone for a safety switch. */
export async function applySuspend(client: PanicClient, desired: boolean): Promise<ApplyResult> {
  const before = await readState(client);
  if (before.suspendTrade === desired) {
    return { changed: false, confirmed: true, before, after: before };
  }
  await client.updateAccountConfigurations({ suspend_trade: desired });
  const after = await readState(client);
  return { changed: true, confirmed: after.suspendTrade === desired, before, after };
}

/** Confirmation policy: activating accepts y/yes; RESUMING only accepts the
 *  literal word "resume" — an accidental keystroke must not re-arm trading. */
export function confirmAnswerAccepted(action: "on" | "off", answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (action === "on") return a === "y" || a === "yes";
  return a === "resume";
}

/** Append one auditable line (timestamped) to the panic log. */
export function appendPanicAudit(line: string, file = "logs/panic.log"): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

export function parseArgs(argv: string[]): { action: "status" | "on" | "off"; yes: boolean } | { error: string } {
  let action: "status" | "on" | "off" = "status";
  let actionSeen = false;
  let yes = false;
  for (const a of argv) {
    if (a === "--yes") { yes = true; continue; }
    if (a.startsWith("--")) return { error: `unknown flag "${a}"` };
    if (a === "status" || a === "on" || a === "off") {
      if (actionSeen) return { error: `more than one action given` };
      action = a; actionSeen = true; continue;
    }
    return { error: `unknown action "${a}" — expected status|on|off` };
  }
  return { action, yes };
}

function fmt(b: boolean | null): string {
  return b === null ? "unknown" : b ? "SUSPENDED" : "active (trading allowed)";
}

function printState(s: PanicState): void {
  console.log(`\n▌ Alpaca broker-side kill switch — account ${s.accountId ?? "?"}`);
  console.log(`  suspend_trade (configurations):        ${fmt(s.suspendTrade)}`);
  console.log(`  trade_suspended_by_user (account):     ${fmt(s.tradeSuspendedByUser)}`);
  console.log(`  Binance: NO API equivalent exists — to kill Binance trading, revoke the`);
  console.log(`  API key (or uncheck "Enable Futures") in the Binance web UI. Do NOT use`);
  console.log(`  countdownCancelAll: it cancels our protective stops.\n`);
}

function makeSdkClient(): PanicClient {
  const Alpaca = require("@alpacahq/alpaca-trade-api");
  return new Alpaca({
    keyId: config.alpaca.keyId,
    secretKey: config.alpaca.secretKey,
    paper: config.alpaca.paper,
    baseUrl: config.alpaca.baseUrl,
  });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    console.error(`Usage: bun scripts/panic.ts [status|on|off] [--yes]`);
    process.exit(2);
  }

  // Same coherence + placeholder guards the executor applies before any
  // network call — this script signs against the SAME account prod trades.
  const mismatch = alpacaPaperLiveMismatch(config.alpaca.paper, config.alpaca.baseUrl);
  if (mismatch) {
    console.error(`✗ SAFETY: ${mismatch} — refusing to touch this account`);
    process.exit(1);
  }
  if (!config.alpaca.keyId || config.alpaca.keyId === "your_alpaca_key") {
    console.error(`✗ Alpaca API keys not configured (.env) — nothing to operate on`);
    process.exit(1);
  }

  const client = makeSdkClient();
  const state = await readState(client); // guardrail (b): show state FIRST
  printState(state);

  if (parsed.action === "status") return;

  const desired = parsed.action === "on";
  if (state.suspendTrade === desired) {
    console.log(`= Already ${desired ? "SUSPENDED" : "active"} — nothing to do (idempotent).`);
    appendPanicAudit(`panic ${parsed.action} (no-op): suspend_trade already ${desired} on account ${state.accountId}`);
    return;
  }

  if (desired) {
    console.log(`  ⚠️  This SUSPENDS all new order submissions on the Alpaca account, for EVERY`);
    console.log(`  process holding these credentials — including this bot's own closes and new`);
    console.log(`  protective stops (existing GTC stops on the books keep working). The bot's`);
    console.log(`  loops keep running and resume when you ./start.sh resume-trading.`);
  } else {
    console.log(`  ⚠️  This RE-ARMS trading on the Alpaca account for every process holding the`);
    console.log(`  credentials. Make sure the reason for the panic is actually resolved.`);
  }

  if (!parsed.yes) {
    const prompt = desired
      ? `Suspend all new orders on account ${state.accountId}? [y/N] `
      : `Type "resume" to re-enable trading on account ${state.accountId}: `;
    if (!confirmAnswerAccepted(parsed.action, await ask(prompt))) {
      console.log("Aborted — no changes made.");
      process.exit(1);
    }
  }

  const result = await applySuspend(client, desired);
  appendPanicAudit(
    `panic ${parsed.action}: suspend_trade ${result.before.suspendTrade} → ${result.after.suspendTrade} ` +
    `(confirmed=${result.confirmed}) on account ${result.after.accountId ?? state.accountId}`,
  );
  if (!result.confirmed) {
    console.error(`✗ PATCH sent but the re-read does NOT confirm suspend_trade=${desired} — verify manually (bun scripts/panic.ts status)`);
    process.exit(1);
  }
  console.log(desired
    ? `✅ Account SUSPENDED at the broker. The bot picks it up within one 60s account sync (or immediately on restart).`
    : `✅ Trading resumed at the broker. The bot re-enables opens within one 60s account sync.`);
  printState(result.after);
}

if (import.meta.main) {
  main().catch((e: any) => {
    console.error(`✗ fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
