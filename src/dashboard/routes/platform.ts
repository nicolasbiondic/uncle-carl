// ═══ /api/platform/me + /api/platform/sessions — identity & sessions ═══
//
// Runs BEHIND server.ts's auth wall and CSRF gate (mutations arrive with a
// session + x-csrf-token). A viewer only ever sees and revokes their OWN
// sessions — the username filter below IS the authorization. /api/auth/me is
// deliberately untouched: this is the richer, platform-level identity.

import express from "express";
import { getSession, loadUsers, sessionsOfUser, revokeSessionByHandle, revokeOtherSessions } from "../auth-store";
import type { Session } from "../auth-store";
import { loadInstanceConfig } from "../../platform/instance";
import { accountIdFor, getInstanceId } from "../../platform/meta";
import { resolveAccountsSource } from "../../platform/accounts/runtime";
import { resolvePortfoliosSource } from "../../portfolios/store";
import { VERSION_INFO } from "../../utils/version";

/** Opaque per-session handle (sha256(sid) prefix) — defined in auth-store so a
 *  session restored after a restart, known only by its hash, has the same one. */
export { sessionHandle } from "../auth-store";

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
  // Live ones plus those restored after a restart whose browser hasn't come
  // back yet (auth-store's dormant sessions).
  app.get("/api/platform/sessions", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    const mine = sessionsOfUser(s.username)
      .sort((a, b) => b.session.lastActivity - a.session.lastActivity)
      .map(({ handle, sid, session: x }) => ({
        handle,
        createdAt: x.createdAt,
        lastActivity: x.lastActivity,
        device: x.userAgent ?? "",
        ip: x.ip ?? "",
        current: sid === s.id,
        rememberMe: x.rememberMe,
      }));
    res.json({ sessions: mine });
  });

  // ── DELETE /api/platform/sessions/:handle — revoke ONE of my sessions ───
  // Only my own — viewer included (the username filter is the authorization).
  app.delete("/api/platform/sessions/:handle", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    const handle = String(req.params.handle);
    const revoked = revokeSessionByHandle(s.username, handle);
    if (!revoked) return res.status(404).json({ error: `No session '${handle}'`, code: "not_found" });
    res.json({ ok: true, current: revoked.sid === s.id });
  });

  // ── POST /api/platform/sessions/revoke-others — keep only this one ──────
  app.post("/api/platform/sessions/revoke-others", (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Authentication required" });
    res.json({ ok: true, revoked: revokeOtherSessions(s.username, s.id) });
  });
}
