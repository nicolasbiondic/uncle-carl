// ═══ /api/auth/* routes ═══

import express from "express";
import crypto from "crypto";
import type { AccountManager } from "../../account/AccountManager";
import {
  USERS, sessions,
  getSession,
  getLoginKey, getLoginAttempt, registerLoginFailure, clearLoginAttempt,
  SESSION_TTL, REMEMBER_ME_TTL,
} from "../auth-store";
import { renderLoginPage } from "../login-page";
import { getClientIp } from "../dashboard-utils";
import { loadInstanceConfig, cookieSecure } from "../../platform/instance";
import { needsFirstRunSetup } from "./setup";
import { createLogger } from "../../utils/logger";

const log = createLogger("Dashboard");

export function registerAuthRoutes(app: express.Application, _am: AccountManager): void {
  // ── Login page ──────────────────────────────────────────────────────────
  // Rendered per request: the "Continue with GitHub/Google" buttons appear
  // only when that provider is configured for this instance, and a brand-new
  // installation (no users at all) goes to the first-run setup page instead.
  app.get("/login", (_req, res) => {
    if (needsFirstRunSetup()) return res.redirect("/setup");
    const oauth = loadInstanceConfig().oauth;
    res.type("html").send(renderLoginPage({ github: !!oauth.github, google: !!oauth.google }));
  });

  // ── POST /api/auth/login ────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const { username, password, rememberMe } = req.body ?? {};
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    if (USERS.length === 0)
      return res.status(503).json({ error: "Dashboard credentials not configured" });

    const normalizedUsername = String(username).toLowerCase().trim();
    const loginKey = getLoginKey(req, normalizedUsername);
    const attempt  = getLoginAttempt(loginKey);

    if (attempt.lockUntil > Date.now()) {
      const retryAfterSec = Math.ceil((attempt.lockUntil - Date.now()) / 1000);
      return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfterSec}s` });
    }

    const user = USERS.find(u => u.username === normalizedUsername);
    if (!user) {
      registerLoginFailure(loginKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) {
      const state = registerLoginFailure(loginKey);
      if (state.lockUntil > Date.now()) {
        const retryAfterSec = Math.ceil((state.lockUntil - Date.now()) / 1000);
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfterSec}s` });
      }
      return res.status(401).json({ error: "Invalid credentials" });
    }

    clearLoginAttempt(loginKey);

    const sid = crypto.randomBytes(32).toString("hex");
    const remember = rememberMe === true || rememberMe === "true";
    const cookieTTL = remember ? REMEMBER_ME_TTL : SESSION_TTL;
    const session = {
      id: sid,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      csrfToken: crypto.randomBytes(24).toString("hex"),
      rememberMe: remember,
      settings: { viewId: "consolidated" },
      // Device metadata for the Ajustes → Sessions list (routes/platform.ts).
      userAgent: String(req.headers["user-agent"] ?? ""),
      ip: getClientIp(req),
    };
    sessions.set(sid, session);

    // Platform phase: Secure is also inferred from an https PUBLIC_URL
    // (behind a TLS tunnel/proxy); explicit DASHBOARD_COOKIE_SECURE=true/false
    // still wins either way (src/platform/instance.ts cookieSecure).
    const secureCookie = cookieSecure();
    res.cookie("sid", sid, {
      httpOnly: true,
      maxAge: cookieTTL,
      sameSite: "strict",
      secure: secureCookie,
      path: "/",
    });
    log.info(`🔑 Login: ${user.displayName} (${user.role})`);
    res.json({
      ok: true,
      user: { username: user.username, displayName: user.displayName, role: user.role },
      csrfToken: session.csrfToken,
    });
  });

  // ── POST /api/auth/logout ───────────────────────────────────────────────
  app.post("/api/auth/logout", (req, res) => {
    const sid = (req as any).cookies?.sid;
    if (sid) sessions.delete(sid);
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  });

  // ── GET /api/auth/me ────────────────────────────────────────────────────
  app.get("/api/auth/me", (req, res) => {
    const s = getSession(req);  // auth wall skips /api/auth/ — must use getSession directly
    if (!s) return res.status(401).json({ error: "Not authenticated" });
    res.json({
      username: s.username,
      displayName: s.displayName,
      role: s.role,
      csrfToken: s.csrfToken,
    });
  });
}
