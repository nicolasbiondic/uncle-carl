// ═══ Per-endpoint sliding-window rate limiter ═══

import type express from "express";
import { getClientIp } from "../dashboard-utils";

interface RateWindow {
  count: number;
  resetAt: number;
}

// Single shared store; cleaned up hourly to prevent unbounded growth
const store = new Map<string, RateWindow>();

setInterval(() => {
  const now = Date.now();
  for (const [k, w] of store) {
    if (now > w.resetAt) store.delete(k);
  }
}, 60 * 60_000);

/**
 * Creates an Express rate-limiting middleware.
 *
 * @param maxRequests  Maximum requests allowed in the window
 * @param windowMs     Window duration in milliseconds
 * @param keyFn        Optional key extractor; defaults to `"ip|path"` per IP
 */
export function rateLimiter(
  maxRequests: number,
  windowMs: number,
  keyFn?: (req: express.Request) => string
): express.RequestHandler {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip  = getClientIp(req);
    const key = keyFn ? keyFn(req) : `${ip}|${req.path}`;
    const now = Date.now();

    let win = store.get(key);
    if (!win || now >= win.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    win.count++;
    if (win.count > maxRequests) {
      const retryAfter = Math.ceil((win.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: `Rate limit exceeded. Retry in ${retryAfter}s.` });
    }
    return next();
  };
}

// ── Pre-built limiters (applied in server.ts) ─────────────────────────────

/** General API reads: 300 req/min per IP across all /api/* paths */
export const apiLimiter = rateLimiter(300, 60_000, (req) => `api|${getClientIp(req)}`);

/** State-changing calls (POST/PUT/DELETE): 60 req/min per IP */
export const mutationLimiter = rateLimiter(60, 60_000, (req) => `mut|${getClientIp(req)}`);

/** Sensitive admin-level endpoints: 20 req/min per IP */
export const adminLimiter = rateLimiter(20, 60_000, (req) => `adm|${getClientIp(req)}`);
