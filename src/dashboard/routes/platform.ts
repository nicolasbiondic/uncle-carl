// ═══ /api/platform/me + /api/platform/sessions — identity & sessions ═══
//
// Runs BEHIND server.ts's auth wall and CSRF gate (mutations arrive with a
// session + x-csrf-token). A viewer only ever sees and revokes their OWN
// sessions — the username filter below IS the authorization. /api/auth/me is
// deliberately untouched: this is the richer, platform-level identity.

import express from "express";
import { createHash } from "crypto";
import { sessions, getSession, loadUsers } from "../auth-store";
import type { Session } from "../auth-store";
import { loadInstanceConfig } from "../../platform/instance";
import { accountIdFor, getInstanceId } from "../../platform/meta";
import { resolveAccountsSource } from "../../platform/accounts/runtime";
import { resolvePortfoliosSource } from "../../portfolios/store";
import { VERSION_INFO } from "../../utils/version";

/** Opaque per-session handle: NEVER the raw sid (a sid is a bearer token). */
export function sessionHandle(sid: string): string {
  return createHash("sha256").update(sid).digest("hex").slice(0, 16);
}

function sessionOf(req: express.Request): Session | null {
  return (req as any).session ?? getSession(req);
}

export function registerPlatformRoutes(app: express.Application): void {
  // ── GET /api/platform/me — identity + installation facts ────────────────
  app.get("/api/platform/me", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    const cfg = loadInstanceConfig();
    const instanceId = getInstanceId();
    let accountsSource: string;
    try { accountsSource = resolveAccountsSource(cfg.accountsSource); } catch { accountsSource = "env"; }
    res.json({
      username: s.username,
      displayName: s.displayName,
      role: s.role,
      accountId: accountIdFor(instanceId, s.username),
      instanceId,
      loginMethods: {
        password: loadUsers().some((u) => u.username === s.username && !!u.passwordHash),
        github: !!cfg.oauth.github,
        google: !!cfg.oauth.google,
      },
      accountsSource,
      portfoliosSource: resolvePortfoliosSource(process.env.PORTFOLIOS_SOURCE),
      commit: VERSION_INFO.commit ?? null,
      publicUrl: cfg.dashboard.publicUrl,
    });
  });

  // ── GET /api/platform/sessions — the CURRENT USER's sessions ────────────
  app.get("/api/platform/sessions", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    const mine = [...sessions.values()]
      .filter((x) => x.username === s.username)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((x) => ({
        handle: sessionHandle(x.id),
        createdAt: x.createdAt,
        lastActivity: x.lastActivity,
        device: x.userAgent ?? "",
        ip: x.ip ?? "",
        current: x.id === s.id,
        rememberMe: x.rememberMe,
      }));
    res.json({ sessions: mine });
  });

  // ── DELETE /api/platform/sessions/:handle — revoke ONE of my sessions ───
  app.delete("/api/platform/sessions/:handle", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    const handle = String(req.params.handle);
    for (const [sid, x] of sessions) {
      if (x.username !== s.username) continue; // only my own — viewer included
      if (sessionHandle(sid) !== handle) continue;
      sessions.delete(sid);
      return res.json({ ok: true, current: sid === s.id });
    }
    res.status(404).json({ error: `No session '${handle}'`, code: "not_found" });
  });

  // ── POST /api/platform/sessions/revoke-others — keep only this one ──────
  app.post("/api/platform/sessions/revoke-others", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    let revoked = 0;
    for (const [sid, x] of sessions) {
      if (x.username === s.username && sid !== s.id) {
        sessions.delete(sid);
        revoked++;
      }
    }
    res.json({ ok: true, revoked });
  });
}
