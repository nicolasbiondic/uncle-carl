import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadInstanceConfig, resetInstanceConfigForTests, publicBaseUrl,
  instanceAllowedOrigins, normalizePublicUrl, instanceDataDir,
  instanceFilePath, cookieSecure,
} from "./instance";
import { config } from "../config";

const ENV_KEYS = [
  "UC_DATA_DIR", "DASHBOARD_HOST", "DASHBOARD_PORT", "PUBLIC_URL",
  "DASHBOARD_ALLOWED_ORIGINS", "DASHBOARD_COOKIE_SECURE",
  "DASHBOARD_ADMIN_USER", "DASHBOARD_ADMIN_PASSWORD_HASH", "DASHBOARD_ADMIN_DISPLAY_NAME",
  "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_ALLOWED_ID", "OAUTH_GITHUB_ALLOWED_LOGIN",
  "OAUTH_GOOGLE_CLIENT_ID", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GOOGLE_ALLOWED_EMAIL",
  "ACCOUNTS_SOURCE", "RUNTIME_ACCOUNT_ALPACA", "RUNTIME_ACCOUNT_BINANCE",
];

let saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-instance-"));
  process.env.UC_DATA_DIR = tmp;
  resetInstanceConfigForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  require("fs").rmSync(tmp, { recursive: true, force: true }); // stale @types/node lacks rmSync (repo-wide dodge)
  resetInstanceConfigForTests();
});

describe("loadInstanceConfig — additive invariant", () => {
  test("no instance.json + no new env vars = EXACTLY today's prod defaults", () => {
    const ic = loadInstanceConfig();
    expect(ic.dashboard.host).toBe("0.0.0.0");       // listen on all interfaces, as today
    expect(ic.dashboard.port).toBe(config.dashboard.port); // EXACTLY what the bot binds today
    expect(ic.dashboard.publicUrl).toBeNull();
    expect(ic.owner).toBeNull();
    expect(ic.oauth.github).toBeNull();
    expect(ic.oauth.google).toBeNull();
    expect(publicBaseUrl()).toBeNull();
    expect(instanceAllowedOrigins()).toEqual([]);     // nothing added to WS origin set
    expect(cookieSecure()).toBe(false);               // same default as routes/auth.ts
    // F4a: no ACCOUNTS_SOURCE anywhere = unset (resolves to "env" in main()).
    expect(ic.accountsSource).toBeNull();
    expect(ic.runtimeAccounts).toEqual({ alpaca: null, binance: null });
  });

  test("dataDir = UC_DATA_DIR, default ./data", () => {
    expect(loadInstanceConfig().dataDir).toBe(tmp);
    delete process.env.UC_DATA_DIR;
    resetInstanceConfigForTests();
    expect(instanceDataDir()).toBe("data");
  });

  test("a corrupt instance.json is ignored (never crashes, falls back to defaults)", () => {
    fs.writeFileSync(instanceFilePath(tmp), "{not json!!");
    const ic = loadInstanceConfig();
    expect(ic.dashboard.port).toBe(config.dashboard.port);
    expect(ic.owner).toBeNull();
  });
});

describe("precedence: env > instance.json > defaults", () => {
  function writeInstance(obj: any) {
    fs.writeFileSync(instanceFilePath(tmp), JSON.stringify(obj));
    resetInstanceConfigForTests();
  }

  test("instance.json values are used when env is unset", () => {
    writeInstance({
      dashboard: { host: "127.0.0.1", port: 4100, publicUrl: "https://bot.example.com/" },
      owner: { username: "Nico", passwordHash: "h", displayName: "Nico" },
      oauth: {
        github: { clientId: "gid", clientSecret: "gs", allowedId: 42, allowedLogin: "nico" },
        google: { clientId: "cid", clientSecret: "cs", allowedEmail: "Nico@Example.com" },
      },
    });
    const ic = loadInstanceConfig();
    expect(ic.dashboard).toEqual({ host: "127.0.0.1", port: 4100, publicUrl: "https://bot.example.com" });
    expect(ic.owner).toEqual({ username: "nico", passwordHash: "h", displayName: "Nico" });
    expect(ic.oauth.github).toEqual({ clientId: "gid", clientSecret: "gs", allowedId: 42, allowedLogin: "nico" });
    expect(ic.oauth.google).toEqual({ clientId: "cid", clientSecret: "cs", allowedEmail: "nico@example.com" });
  });

  test("env overrides instance.json", () => {
    writeInstance({ dashboard: { host: "127.0.0.1", port: 4100, publicUrl: "https://file.example.com" } });
    process.env.DASHBOARD_HOST = "0.0.0.0";
    process.env.DASHBOARD_PORT = "5200";
    process.env.PUBLIC_URL = "https://env.example.com";
    resetInstanceConfigForTests();
    const ic = loadInstanceConfig();
    expect(ic.dashboard).toEqual({ host: "0.0.0.0", port: 5200, publicUrl: "https://env.example.com" });
  });

  test("owner reflects instance.json only — env admin users stay in auth-store's loadUsersFromEnv", () => {
    writeInstance({ owner: { username: "fileuser", passwordHash: "fh" } });
    process.env.DASHBOARD_ADMIN_USER = "EnvUser";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "eh";
    resetInstanceConfigForTests();
    expect(loadInstanceConfig().owner).toEqual({ username: "fileuser", passwordHash: "fh", displayName: "Owner" });
  });

  test("incomplete oauth blocks are rejected (null), not half-configured", () => {
    writeInstance({ oauth: { github: { clientId: "x" }, google: { clientId: "y", clientSecret: "z" } } });
    const ic = loadInstanceConfig();
    expect(ic.oauth.github).toBeNull();
    expect(ic.oauth.google).toBeNull();
  });

  test("F4a: accountsSource + runtimeAccounts — file values, env wins", () => {
    writeInstance({
      accountsSource: "registry",
      runtimeAccounts: { alpaca: "alpaca-paper", binance: "binance-demo-usdt-usdc" },
    });
    let ic = loadInstanceConfig();
    expect(ic.accountsSource).toBe("registry");
    expect(ic.runtimeAccounts).toEqual({ alpaca: "alpaca-paper", binance: "binance-demo-usdt-usdc" });
    // env > instance.json, per-field
    process.env.ACCOUNTS_SOURCE = "env";
    process.env.RUNTIME_ACCOUNT_BINANCE = "other-binance";
    resetInstanceConfigForTests();
    ic = loadInstanceConfig();
    expect(ic.accountsSource).toBe("env");
    expect(ic.runtimeAccounts).toEqual({ alpaca: "alpaca-paper", binance: "other-binance" });
  });

  test("config is cached until resetInstanceConfigForTests", () => {
    const a = loadInstanceConfig();
    writeInstance({ dashboard: { port: 4999 } }); // calls reset internally
    const b = loadInstanceConfig();
    expect(a.dashboard.port).toBe(config.dashboard.port);
    expect(b.dashboard.port).toBe(4999);
  });
});

describe("normalizePublicUrl", () => {
  test("strips trailing slashes, keeps paths, drops query/hash", () => {
    expect(normalizePublicUrl("https://bot.example.com/")).toBe("https://bot.example.com");
    expect(normalizePublicUrl("https://bot.example.com/sub/")).toBe("https://bot.example.com/sub");
    expect(normalizePublicUrl("http://h:8080/x?a=1#b")).toBe("http://h:8080/x");
  });
  test("invalid / non-http(s) / credentialed URLs → null", () => {
    expect(normalizePublicUrl("not a url")).toBeNull();
    expect(normalizePublicUrl("ftp://x.com")).toBeNull();
    expect(normalizePublicUrl("https://user:pw@x.com")).toBeNull();
    expect(normalizePublicUrl(null)).toBeNull();
    expect(normalizePublicUrl("")).toBeNull();
  });
});

describe("instanceAllowedOrigins", () => {
  test("PUBLIC_URL origin first, then DASHBOARD_ALLOWED_ORIGINS, deduped", () => {
    process.env.PUBLIC_URL = "https://bot.example.com/dash";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://bot.example.com, http://other.example.com";
    resetInstanceConfigForTests();
    expect(instanceAllowedOrigins()).toEqual(["https://bot.example.com", "http://other.example.com"]);
  });
});

describe("cookieSecure", () => {
  test("inferred true from https PUBLIC_URL; explicit env always wins", () => {
    process.env.PUBLIC_URL = "https://bot.example.com";
    resetInstanceConfigForTests();
    expect(cookieSecure()).toBe(true);
    process.env.DASHBOARD_COOKIE_SECURE = "false"; // explicit override (e.g. plain-http LAN)
    expect(cookieSecure()).toBe(false);
    process.env.DASHBOARD_COOKIE_SECURE = "true";
    expect(cookieSecure()).toBe(true);
  });
  test("http PUBLIC_URL does not force Secure", () => {
    process.env.PUBLIC_URL = "http://bot.example.com";
    resetInstanceConfigForTests();
    expect(cookieSecure()).toBe(false);
  });
});
