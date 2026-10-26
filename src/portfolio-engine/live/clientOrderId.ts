// ═══ Portfolio engine — deterministic client order ids ═══
//
// One order per (sleeve, execution session, symbol[, maxHold leg]): the SAME key always
// derives the SAME id, so a resubmission after a restart inside the session is
// rejected by the venue as a duplicate and the engine queries the existing
// order instead (VenueAdapter.submit contract).
//
// Format: `uc8-<sleeve≤12>-pf<sha256(sleeve|session|symbol)[0:16]>`
//   - `uc8-` keeps the bot-attribution prefix every Alpaca order carries
//     (CLIENT_ORDER_ID_PREFIX in alpaca-executor.ts: anything without it is
//     provably not ours), with the sleeve part readable for audits;
//   - `pf` marks portfolio-engine orders inside that namespace;
//   - total length ≤ 35, inside Binance's 36-char newClientOrderId cap and
//     Alpaca's 128 — one scheme for every venue;
//   - the hash covers the FULL sleeve id, so the readable truncation can never
//     collide.

import { createHash } from "crypto";
import type { SessionDate } from "../types";

export const PORTFOLIO_CLIENT_ID_PREFIX = "uc8";
export const PORTFOLIO_CLIENT_ID_MARK = "pf";
const SLEEVE_PART_MAX = 12;
const HASH_LEN = 16;
/** Binance newClientOrderId: ^[\.A-Z\:/a-z0-9_-]{1,36}$ — the tighter cap. */
export const PORTFOLIO_CLIENT_ID_MAX_LEN = 36;

export function sleeveIdPart(accountId: string): string {
  const cleaned = accountId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, SLEEVE_PART_MAX);
  return cleaned || "x";
}

export function portfolioClientOrderId(accountId: string, session: SessionDate, symbol: string, leg?: "close" | "rebuy"): string {
  // Preserve every default-off id; renewal needs TWO durable identities for the same symbol/session.
  const hash = createHash("sha256").update(`${accountId}|${session}|${symbol}${leg ? `|maxHold:${leg}` : ""}`).digest("hex").slice(0, HASH_LEN);
  const id = `${PORTFOLIO_CLIENT_ID_PREFIX}-${sleeveIdPart(accountId)}-${PORTFOLIO_CLIENT_ID_MARK}${hash}`;
  if (id.length > PORTFOLIO_CLIENT_ID_MAX_LEN) throw new Error(`client order id too long: ${id}`);
  return id;
}

export function isPortfolioClientOrderId(id: string): boolean {
  return new RegExp(`^${PORTFOLIO_CLIENT_ID_PREFIX}-[a-zA-Z0-9_]{1,${SLEEVE_PART_MAX}}-${PORTFOLIO_CLIENT_ID_MARK}[0-9a-f]{${HASH_LEN}}$`).test(id);
}
