// ═══ Shared dashboard utilities ═══

import type express from "express";

/** Clamp and parse a query-param integer (prevents unbounded DB queries). */
export function toBoundedInt(
  value: any,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Extract the real client IP from the request.
 *
 * Iter 8 fix (2026-05-04): the previous implementation blindly trusted the
 * left-most `X-Forwarded-For` value, which let any external attacker forge
 * a fresh IP per request and bypass:
 *   - apiLimiter (300 req/min/IP)
 *   - mutationLimiter (60 req/min/IP)
 *   - adminLimiter (20 req/min/IP)
 *   - login lockout (8 attempts per username|IP)
 * by simply spamming `X-Forwarded-For: 1.2.3.<rand>` headers.
 *
 * We now only honour XFF when `TRUST_PROXY=true` is set, in which case we
 * take the *right-most* hop (the closest trusted proxy). Otherwise we use
 * the direct socket peer.
 */
export function getClientIp(req: express.Request): string {
  const trustProxy = String(process.env.TRUST_PROXY ?? "false") === "true";
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      const hops = xff.split(",").map(s => s.trim()).filter(Boolean);
      // Right-most hop is the one closest to our edge — the only one we can
      // (transitively) trust assuming our reverse proxy strips earlier hops
      // before re-adding its own. With multiple trusted proxies the operator
      // is expected to chain them via a hop count config — out of scope here.
      const rightmost = hops[hops.length - 1];
      if (rightmost) return rightmost;
    }
  }
  return req.socket.remoteAddress || "unknown";
}
