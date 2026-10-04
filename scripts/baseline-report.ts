import { mkdirSync, writeFileSync, readFileSync } from "fs";

// Derive the default port from .env — a hardcoded 3789 would silently hit
// prod (or a tunnel to it) on this host, which serves on 3799. Same pattern
// as start.sh / watchdog.sh.
function defaultBaseUrl(): string {
  try {
    const env = readFileSync(".env", "utf8");
    const m = env.match(/^DASHBOARD_PORT=(\d+)/m);
    if (m) return `http://127.0.0.1:${m[1]}`;
  } catch {
    // .env missing — fall through to the historical default
  }
  return "http://127.0.0.1:3789";
}

type EndpointResult = {
  endpoint: string;
  runs: number;
  statusCounts: Record<string, number>;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  avgMs: number;
  avgBytes: number;
};

const BASE_URL = process.env.BASELINE_BASE_URL || defaultBaseUrl();
const USERNAME = process.env.BASELINE_USERNAME || process.env.DASHBOARD_ADMIN_USER || "";
const PASSWORD = process.env.BASELINE_PASSWORD || process.env.DASHBOARD_ADMIN_PASSWORD || "";
const RUNS = Number(process.env.BASELINE_RUNS || "15");

const AUTH_ENDPOINTS = [
  "/api/dashboard",
  "/api/stats",
  "/api/trades?limit=100",
  "/api/equity/history?profile_id=consolidated&range=24h",
  "/api/v2/profiles",
  "/api/activity?limit=100",
] as const;

const PUBLIC_ENDPOINTS = ["/healthz", "/metrics", "/login"] as const;

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function timedFetch(url: string, init?: RequestInit): Promise<{ ms: number; status: number; bytes: number }> {
  const start = performance.now();
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    ms: performance.now() - start,
    status: res.status,
    bytes: text.length,
  };
}

async function loginAndGetCookie(): Promise<string> {
  const loginUrl = `${BASE_URL}/api/auth/login`;
  const response = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Login failed (${response.status}): ${body.slice(0, 250)}`);
  }

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Login succeeded but set-cookie header missing");
  const cookie = setCookie.split(";")[0];
  if (!cookie.startsWith("sid=")) throw new Error(`Unexpected cookie format: ${cookie}`);
  return cookie;
}

async function runEndpoint(endpoint: string, runs: number, cookie?: string): Promise<EndpointResult> {
  const times: number[] = [];
  const sizes: number[] = [];
  const statusCounts: Record<string, number> = {};

  for (let i = 0; i < runs; i++) {
    const { ms, status, bytes } = await timedFetch(`${BASE_URL}${endpoint}`, {
      headers: cookie ? { Cookie: cookie } : undefined,
    });

    times.push(ms);
    sizes.push(bytes);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const avgBytes = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  return {
    endpoint,
    runs,
    statusCounts,
    minMs: Number(Math.min(...times).toFixed(2)),
    medianMs: Number(pct(times, 50).toFixed(2)),
    p95Ms: Number(pct(times, 95).toFixed(2)),
    avgMs: Number(avgMs.toFixed(2)),
    avgBytes: Number(avgBytes.toFixed(0)),
  };
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Missing baseline credentials. Set BASELINE_USERNAME and BASELINE_PASSWORD.");
  }

  const startedAt = new Date();
  console.log(`📏 Baseline starting at ${startedAt.toISOString()} (${BASE_URL})`);

  const cookie = await loginAndGetCookie();

  const authResults: EndpointResult[] = [];
  for (const endpoint of AUTH_ENDPOINTS) {
    authResults.push(await runEndpoint(endpoint, RUNS, cookie));
  }

  const publicResults: EndpointResult[] = [];
  for (const endpoint of PUBLIC_ENDPOINTS) {
    publicResults.push(await runEndpoint(endpoint, 3));
  }

  const report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    runsPerAuthEndpoint: RUNS,
    authenticatedEndpoints: authResults,
    publicEndpoints: publicResults,
  };

  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outDir = "reports/baseline";
  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/baseline-${timestamp}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`✅ Baseline report saved: ${outPath}`);
  console.table(
    authResults.map((r) => ({ endpoint: r.endpoint, medianMs: r.medianMs, p95Ms: r.p95Ms, status: JSON.stringify(r.statusCounts) }))
  );
}

main().catch((err) => {
  console.error("❌ Baseline failed:", err);
  process.exit(1);
});
