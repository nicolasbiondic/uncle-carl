// Usage:
//   bun run verify
//   VERIFY_USERNAME=admin VERIFY_PASSWORD=your-plaintext-password bun run verify
//
// VERIFY_USERNAME defaults to DASHBOARD_ADMIN_USER (the admin username, usually "admin").
// VERIFY_PASSWORD must be the PLAINTEXT password — NOT the bcrypt hash from
// DASHBOARD_ADMIN_PASSWORD_HASH. Set VERIFY_PASSWORD explicitly for authenticated checks.
const BASE_URL = process.env.VERIFY_BASE_URL || "http://127.0.0.1:3789";
const USERNAME = process.env.VERIFY_USERNAME || process.env.DASHBOARD_ADMIN_USER || "";
const PASSWORD = process.env.VERIFY_PASSWORD || "";

async function assertStatus(path: string, expected: number, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.text();
  if (res.status !== expected) {
    throw new Error(`${path} expected ${expected}, got ${res.status}. Body: ${body.slice(0, 300)}`);
  }
  return body;
}

async function main() {
  console.log(`🔎 Smoke verification: ${BASE_URL}`);

  await assertStatus("/login", 200);
  await assertStatus("/healthz", 200);
  await assertStatus("/metrics", 401);
  await assertStatus("/healthz/full", 401);
  await assertStatus("/api/dashboard", 401);

  if (!USERNAME || !PASSWORD) {
    console.log("✅ Public smoke verification passed (authenticated checks skipped; set VERIFY_USERNAME and VERIFY_PASSWORD).");
    return;
  }

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  if (!loginRes.ok) {
    throw new Error(`/api/auth/login failed (${loginRes.status}): ${(await loginRes.text()).slice(0, 250)}`);
  }

  const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie.startsWith("sid=")) {
    throw new Error("Expected sid cookie after login");
  }

  await assertStatus("/api/auth/me", 200, { headers: { Cookie: cookie } });
  await assertStatus("/metrics", 200, { headers: { Cookie: cookie } });
  await assertStatus("/api/dashboard", 200, { headers: { Cookie: cookie } });
  await assertStatus("/api/v2/profiles", 200, { headers: { Cookie: cookie } });

  console.log("✅ Smoke verification passed");
}

main().catch((err) => {
  console.error("❌ Smoke verification failed:", err);
  process.exit(1);
});
