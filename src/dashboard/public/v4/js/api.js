// ── api.js — the ONLY place that talks HTTP. Handles credentials, CSRF, JSON,
// and errors uniformly. Components call api.dashboard(), api.trades(), etc.

let csrfToken = "";
export function setCsrf(t) { csrfToken = t || ""; }

async function req(path, { method = "GET", body } = {}) {
  const opts = {
    method,
    credentials: "same-origin",
    headers: { "Accept": "application/json" },
  };
  // CSRF on every state-changing call (server.ts gates ALL non-GET /api/*) —
  // body-less mutations like DELETE need the header too.
  if (csrfToken && method !== "GET") opts.headers["x-csrf-token"] = csrfToken;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status, data });
  return data;
}

/** GET that never throws — returns fallback on any error (for optional cards). */
async function soft(path, fallback = null) {
  try { return await req(path); } catch { return fallback; }
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
};

export const api = {
  req, soft,
  // auth / session
  me: () => soft("/api/auth/me"),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  // core
  dashboard: (view) => req("/api/dashboard" + qs({ view })),
  profilesV2: (days) => req("/api/v2/profiles" + qs({ days })),
  sleeveRisk: () => soft("/api/v2/sleeves/risk", { sleeves: [] }),
  connections: () => soft("/api/connections", {}),
  activity: (limit = 60, type) => soft("/api/activity" + qs({ limit, type: type && type !== "all" ? type : "" }), []),
  trades: (limit = 100, account) => soft("/api/trades" + qs({ limit, account }), []),
  equityHistory: ({ account = "consolidated", days, range } = {}) => soft("/api/equity/history" + qs({ account, days, range }), []),
  // analytics — the v8 market-monitor/agent/strategies-matrix endpoints were
  // removed backend-side (2026-07-09/13); their frontend callers went with them.
  monthlyReturns: (profile = "binance_main", months = 12) => soft("/api/analytics/monthly-returns" + qs({ profile, months }), []),
  drawdown: (profile = "binance_main", days = 90) => soft("/api/analytics/drawdown" + qs({ profile, days }), []),
  slippage: (account) => soft("/api/analytics/slippage" + qs({ account })),
  scorecard: () => soft("/api/v2/scorecard"),
  pnlBreakdown: (days = 7) => soft("/api/v2/pnl-breakdown" + qs({ days })),
  pnlAttribution: (days = 365) => soft("/api/analytics/pnl-attribution" + qs({ days })),
  symbolsAnalytics: (days = 30) => soft("/api/analytics/symbols" + qs({ days }), []),
  hourly: (days = 30) => soft("/api/analytics/hourly" + qs({ days }), []),
  // microstructure / charts
  candles: (symbol, tf = "1h", limit = 200) => soft(`/api/candles/${encodeURIComponent(symbol)}` + qs({ tf, limit })),
  orderbook: (symbol, limit = 10) => soft("/api/orderbook" + qs({ symbol, limit })),
  tape: (symbol, limit = 24) => soft("/api/tape" + qs({ symbol, limit })),
  // admin
  configKeys: () => soft("/api/config/keys"),
  // platform identity + sessions (src/dashboard/routes/platform.ts)
  platformMe: () => soft("/api/platform/me", null),
  platformSessions: () => soft("/api/platform/sessions", null),
  revokeSession: (handle) => req(`/api/platform/sessions/${encodeURIComponent(handle)}`, { method: "DELETE" }),
  revokeOtherSessions: () => req("/api/platform/sessions/revoke-others", { method: "POST", body: {} }),
  // platform broker-account registry (src/dashboard/routes/accounts.ts)
  platformAccounts: () => soft("/api/platform/accounts", null),
  addPlatformAccount: (body) => req("/api/platform/accounts", { method: "POST", body }),
  verifyPlatformAccount: (id) => req(`/api/platform/accounts/${encodeURIComponent(id)}/verify`, { method: "POST", body: {} }),
  deletePlatformAccount: (id) => req(`/api/platform/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokePlatformAccount: (id) => req(`/api/platform/accounts/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {} }),
  platformPortfolios: () => soft("/api/platform/portfolios", null), // F3c platform registry (soft: null until the route is mounted)
  platformPortfoliosMeta: () => soft("/api/platform/portfolios/meta", { writable: false, presets: [], accounts: [] }),
  createPlatformPortfolio: (body) => req("/api/platform/portfolios", { method: "POST", body }),
  patchPlatformPortfolio: (id, body) => req(`/api/platform/portfolios/${encodeURIComponent(id)}`, { method: "PATCH", body }),
};
