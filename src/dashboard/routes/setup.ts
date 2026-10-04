// ═══ First-run web setup — /setup + POST /api/setup ═══
//
// Active ONLY while the installation has no user at all (no env-configured
// DASHBOARD_ADMIN_*/VIEWER_* and no instance.json owner). Claiming the
// installation requires a ONE-TIME token printed in the server log at
// startup — reaching the port is not enough; you must be able to read the
// host's log. After the owner is created (here or via `bun run setup`),
// every route in this module turns itself off (404/redirect) — checked per
// request, no restart needed.

import express from "express";
import crypto from "crypto";
import { USERS, reloadUsers } from "../auth-store";
import { SETUP_PAGE } from "../setup-page";
import {
  readInstanceJson, mergeInstanceUpdate, writeInstanceJson, ensureMasterKey,
  validateOwnerUsername, validateOwnerPassword, hashOwnerPassword,
} from "../../platform/instanceFile";
import { instanceDataDir, resetInstanceConfigForTests } from "../../platform/instance";
import { rateLimiter } from "../middleware/rateLimiter";
import { createLogger } from "../../utils/logger";

const log = createLogger("Dashboard");

/** No owner anywhere (env or instance.json)? Then the dashboard serves the
 *  first-run setup page instead of the login. Evaluated per request —
 *  USERS is live (reloadUsers mutates it in place). */
export function needsFirstRunSetup(): boolean {
  return USERS.length === 0;
}

// ── One-time token ─────────────────────────────────────────────────────────

let setupToken: string | null = null;

/** Generate (once) and log the first-run token. Called from server.ts at
 *  construction when needsFirstRunSetup(); safe to call repeatedly. */
export function announceSetupTokenIfNeeded(): void {
  if (!needsFirstRunSetup()) return;
  if (!setupToken) setupToken = crypto.randomBytes(16).toString("hex");
  // log.warn (not info) so it survives LOG_LEVEL=WARN; printed each boot
  // until the owner exists.
  log.warn("══════════════════════════════════════════════════════════");
  log.warn("  FIRST-RUN SETUP TOKEN (open /setup in your browser):");
  log.warn(`      ${setupToken}`);
  log.warn("  Anyone with this token can claim this installation.");
  log.warn("══════════════════════════════════════════════════════════");
}

export function resetSetupTokenForTests(token: string | null = null): void {
  setupToken = token;
}

/** Exposed for tests only (never over HTTP). */
export function getSetupTokenForTests(): string | null {
  return setupToken;
}

function tokenMatches(provided: string): boolean {
  if (!setupToken || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Routes (registered BEFORE the auth wall; each handler re-checks) ──────

// Token guessing / spam cap, far below the 128-bit token's search space
// anyway. Separate window from the generic mutationLimiter.
const setupLimiter = rateLimiter(10, 60_000, (req) => `setup|${req.socket.remoteAddress ?? "?"}`);

export function registerSetupRoutes(app: express.Application): void {
  app.get("/setup", (_req, res) => {
    if (!needsFirstRunSetup()) return res.redirect("/login");
    res.type("html").send(SETUP_PAGE);
  });

  app.post("/api/setup", setupLimiter, async (req, res) => {
    if (!needsFirstRunSetup()) {
      return res.status(410).json({ error: "Setup already completed" });
    }
    const { token, username, password } = req.body ?? {};
    if (!tokenMatches(String(token ?? ""))) {
      log.warn("First-run setup: rejected attempt with a wrong/missing token");
      return res.status(403).json({ error: "Invalid setup token — copy it from the server log" });
    }
    const userErr = validateOwnerUsername(String(username ?? ""));
    if (userErr) return res.status(400).json({ error: userErr });
    const passErr = validateOwnerPassword(String(password ?? ""));
    if (passErr) return res.status(400).json({ error: passErr });

    const dataDir = instanceDataDir();
    const passwordHash = await hashOwnerPassword(String(password));
    let existing: any;
    try {
      existing = readInstanceJson(dataDir);
    } catch (e: any) {
      log.error(`First-run setup: existing instance.json is corrupt (${e?.message ?? e}) — refusing to overwrite it`);
      return res.status(500).json({ error: "instance.json exists but is corrupt — fix or remove it on the host" });
    }
    const merged = mergeInstanceUpdate(existing, {
      owner: { username: String(username), passwordHash },
    });
    writeInstanceJson(dataDir, merged);
    const masterKey = ensureMasterKey(dataDir);

    resetInstanceConfigForTests(); // drop the cached "no owner" view
    reloadUsers();
    setupToken = null; // single use

    log.info(`✅ First-run setup complete: owner "${merged.owner.username}" created (master.key ${masterKey.created ? "created" : "kept"})`);
    res.json({
      ok: true,
      username: merged.owner.username,
      next: "/login",
    });
  });
}
