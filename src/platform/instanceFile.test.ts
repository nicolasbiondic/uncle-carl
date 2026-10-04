import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readInstanceJson, mergeInstanceUpdate, writeInstanceJson, ensureMasterKey,
  validateOwnerUsername, validateOwnerPassword, hashOwnerPassword,
  dashboardBaseUrl, oauthCallbackUrls,
} from "./instanceFile";
import { instanceFilePath, resetInstanceConfigForTests } from "./instance";
import { decodeMasterKey } from "./secretBox";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-instancefile-"));
});
afterEach(() => {
  require("fs").rmSync(tmp, { recursive: true, force: true }); // stale @types/node lacks rmSync (repo-wide dodge)
  resetInstanceConfigForTests();
});

describe("writeInstanceJson", () => {
  test("creates the file with mode 0600 and valid JSON", () => {
    const p = writeInstanceJson(tmp, { dashboard: { port: 4100 } });
    expect(p).toBe(instanceFilePath(tmp));
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ dashboard: { port: 4100 } });
  });

  test("creates missing parent directories", () => {
    const nested = path.join(tmp, "a", "b");
    writeInstanceJson(nested, {});
    expect(fs.existsSync(instanceFilePath(nested))).toBe(true);
  });
});

describe("mergeInstanceUpdate — idempotent, additive", () => {
  test("merges dashboard fields without clobbering others", () => {
    const existing = {
      dashboard: { host: "127.0.0.1", port: 4100, publicUrl: "https://x.com" },
      owner: { username: "a", passwordHash: "h" },
      oauth: { github: { clientId: "g", clientSecret: "s", allowedId: 1 } },
    };
    const merged = mergeInstanceUpdate(existing, { dashboard: { port: 5000 } });
    expect(merged.dashboard).toEqual({ host: "127.0.0.1", port: 5000, publicUrl: "https://x.com" });
    expect(merged.owner).toEqual(existing.owner);
    expect(merged.oauth).toEqual(existing.oauth);
  });

  test("publicUrl: null clears it; oauth provider: null removes it", () => {
    const existing = {
      dashboard: { publicUrl: "https://x.com" },
      oauth: {
        github: { clientId: "g", clientSecret: "s", allowedId: 1 },
        google: { clientId: "c", clientSecret: "cs", allowedEmail: "a@b.c" },
      },
    };
    const merged = mergeInstanceUpdate(existing, {
      dashboard: { publicUrl: null },
      oauth: { github: null },
    });
    expect(merged.dashboard.publicUrl).toBeUndefined();
    expect(merged.oauth.github).toBeUndefined();
    expect(merged.oauth.google).toEqual(existing.oauth.google);
  });

  test("owner update lowercases username and defaults displayName", () => {
    const merged = mergeInstanceUpdate({}, { owner: { username: " Nico ", passwordHash: "h" } });
    expect(merged.owner).toEqual({ username: "nico", passwordHash: "h", displayName: "Nico" });
  });

  test("applying the same update twice yields the same result (idempotent)", () => {
    const update = { dashboard: { port: 4100, publicUrl: "https://y.com" } };
    const once = mergeInstanceUpdate({}, update);
    const twice = mergeInstanceUpdate(once, update);
    expect(twice).toEqual(once);
  });
});

describe("readInstanceJson", () => {
  test("missing file → {}; corrupt file → throws (setup must not discard it)", () => {
    expect(readInstanceJson(tmp)).toEqual({});
    fs.writeFileSync(instanceFilePath(tmp), "{broken");
    expect(() => readInstanceJson(tmp)).toThrow();
  });
});

describe("ensureMasterKey", () => {
  test("creates a 32-byte base64 key with mode 0600; NEVER overwrites", () => {
    const first = ensureMasterKey(tmp);
    expect(first.created).toBe(true);
    expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
    const raw1 = fs.readFileSync(first.path, "utf8");
    expect(decodeMasterKey(raw1)).not.toBeNull();

    const second = ensureMasterKey(tmp);
    expect(second.created).toBe(false);
    expect(fs.readFileSync(second.path, "utf8")).toBe(raw1); // byte-identical
  });
});

describe("owner validation + hashing", () => {
  test("username rules", () => {
    expect(validateOwnerUsername("nico")).toBeNull();
    expect(validateOwnerUsername("a.b-c_d9")).toBeNull();
    expect(validateOwnerUsername("ab")).not.toBeNull();
    expect(validateOwnerUsername("has space")).not.toBeNull();
    expect(validateOwnerUsername("x".repeat(33))).not.toBeNull();
  });

  test("password rules", () => {
    expect(validateOwnerPassword("12345678")).toBeNull();
    expect(validateOwnerPassword("short")).not.toBeNull();
    expect(validateOwnerPassword("x".repeat(257))).not.toBeNull();
  });

  test("hashOwnerPassword produces argon2id verifiable by Bun.password.verify (the login route's verifier)", async () => {
    const hash = await hashOwnerPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await Bun.password.verify("correct horse battery staple", hash)).toBe(true);
    expect(await Bun.password.verify("wrong", hash)).toBe(false);
  });
});

describe("URLs", () => {
  test("dashboardBaseUrl prefers normalized publicUrl, falls back to localhost:port", () => {
    expect(dashboardBaseUrl("https://bot.example.com/", 3789)).toBe("https://bot.example.com");
    expect(dashboardBaseUrl(null, 4100)).toBe("http://localhost:4100");
    expect(dashboardBaseUrl("garbage", 4100)).toBe("http://localhost:4100");
  });

  test("oauthCallbackUrls match the routes the dashboard registers", () => {
    expect(oauthCallbackUrls("https://bot.example.com", 3789)).toEqual({
      github: "https://bot.example.com/auth/oauth/github/callback",
      google: "https://bot.example.com/auth/oauth/google/callback",
    });
  });
});
