// Pure parts of `bun run setup` (scripts/setup.ts) against a temp dir.
// The interactive prompt path is not tested (TTY); everything it feeds into
// (merge, write, master key, validation, hashing) is — here and in
// src/platform/instanceFile.test.ts.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { parseSetupArgs, buildUpdateFromArgs, withNewInstallAccountsSource } from "./setup";
import { mergeInstanceUpdate, writeInstanceJson, readInstanceJson, ensureMasterKey, hashOwnerPassword } from "../src/platform/instanceFile";
import { instanceFilePath } from "../src/platform/instance";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-setup-")); });
afterEach(() => { require("fs").rmSync(tmp, { recursive: true, force: true }); });

describe("parseSetupArgs", () => {
  test("parses the documented non-interactive flags", () => {
    const args = parseSetupArgs([
      "--yes", "--port", "4100", "--public-url", "https://bot.example.com",
      "--owner", "nico", "--password-stdin",
      "--github-client-id", "gid", "--github-client-secret", "gs", "--github-allowed-id", "42",
      "--google-client-id", "cid", "--google-client-secret", "cs", "--google-allowed-email", "A@B.com",
    ]);
    expect(args).toMatchObject({
      yes: true, passwordStdin: true, port: 4100, publicUrl: "https://bot.example.com",
      owner: "nico", githubClientId: "gid", githubAllowedId: 42, googleAllowedEmail: "A@B.com",
    });
  });

  test("rejects unknown flags, missing values and bad numbers", () => {
    expect(() => parseSetupArgs(["--bogus"])).toThrow("Unknown flag");
    expect(() => parseSetupArgs(["--port"])).toThrow("needs a value");
    expect(() => parseSetupArgs(["--port", "nope"])).toThrow("positive integer");
    expect(() => parseSetupArgs(["--port", "70000"])).toThrow("out of range");
  });
});

describe("buildUpdateFromArgs", () => {
  test("owner requires a password hash", () => {
    expect(() => buildUpdateFromArgs(parseSetupArgs(["--owner", "nico"]), null)).toThrow("--password-stdin");
  });

  test("invalid public URL is rejected", () => {
    expect(() => buildUpdateFromArgs(parseSetupArgs(["--public-url", "not a url"]), null)).toThrow("not a valid http(s) URL");
  });

  test("partial oauth flags are rejected (no half-configured providers)", () => {
    expect(() => buildUpdateFromArgs(parseSetupArgs(["--github-client-id", "x"]), null)).toThrow("GitHub OAuth needs");
    expect(() => buildUpdateFromArgs(parseSetupArgs(["--google-client-id", "x"]), null)).toThrow("Google OAuth needs");
  });

  test("full update: normalized URL, lowercased google email", () => {
    const update = buildUpdateFromArgs(parseSetupArgs([
      "--port", "4100", "--public-url", "https://bot.example.com/",
      "--owner", "Nico", "--display-name", "Nico",
      "--google-client-id", "cid", "--google-client-secret", "cs", "--google-allowed-email", "Me@Example.COM",
    ]), "HASH");
    expect(update.dashboard).toEqual({ port: 4100, publicUrl: "https://bot.example.com" });
    expect(update.owner).toEqual({ username: "Nico", passwordHash: "HASH", displayName: "Nico" });
    expect(update.oauth?.google?.allowedEmail).toBe("me@example.com");
  });
});

describe("end-to-end file writes (the non-interactive write path)", () => {
  test("setup writes 0600 instance.json + master.key; re-run is idempotent and never rotates the key", async () => {
    const hash = await hashOwnerPassword("a-strong-password");
    const update = buildUpdateFromArgs(parseSetupArgs([
      "--port", "4100", "--public-url", "https://bot.example.com", "--owner", "nico",
    ]), hash);

    // First run
    writeInstanceJson(tmp, mergeInstanceUpdate(readInstanceJson(tmp), update));
    const key1 = ensureMasterKey(tmp);
    expect(key1.created).toBe(true);
    const written = readInstanceJson(tmp);
    expect(written.owner).toEqual({ username: "nico", passwordHash: hash, displayName: "nico" });
    expect(fs.statSync(instanceFilePath(tmp)).mode & 0o777).toBe(0o600);

    // Re-run with only a port change: owner + key survive untouched
    writeInstanceJson(tmp, mergeInstanceUpdate(readInstanceJson(tmp), { dashboard: { port: 5200 } }));
    const key2 = ensureMasterKey(tmp);
    expect(key2.created).toBe(false);
    const rewritten = readInstanceJson(tmp);
    expect(rewritten.dashboard).toEqual({ port: 5200, publicUrl: "https://bot.example.com" });
    expect(rewritten.owner.passwordHash).toBe(hash);
    expect(await Bun.password.verify("a-strong-password", rewritten.owner.passwordHash)).toBe(true);
  });
});

// F4b: a NEW installation reads broker credentials from the accounts
// registry (accountsSource "registry" written into the fresh instance.json);
// EXISTING installations — prod — are never flipped by a setup re-run.
describe("withNewInstallAccountsSource", () => {
  test("new install (no prior instance.json) → accountsSource registry", () => {
    expect(withNewInstallAccountsSource({ dashboard: { port: 3789 } }, true))
      .toEqual({ dashboard: { port: 3789 }, accountsSource: "registry" });
  });
  test("existing installation is untouched (stays env/unset)", () => {
    expect(withNewInstallAccountsSource({ dashboard: { port: 3789 } }, false))
      .toEqual({ dashboard: { port: 3789 } });
  });
  test("an explicit accountsSource is never overwritten", () => {
    expect(withNewInstallAccountsSource({ accountsSource: "env" }, true))
      .toEqual({ accountsSource: "env" });
  });
});

describe("envOverrideWarnings — env beats instance.json, and setup says so", () => {
  test("warns only for a set env var that differs from the saved value", async () => {
    const { envOverrideWarnings } = await import("./setup");
    const written = { dashboard: { port: 4999, host: "127.0.0.1", publicUrl: null } };
    expect(envOverrideWarnings(written, { DASHBOARD_PORT: "3789" })).toHaveLength(1);
    expect(envOverrideWarnings(written, { DASHBOARD_PORT: "4999", DASHBOARD_HOST: "" })).toEqual([]);
    expect(envOverrideWarnings(written, { PUBLIC_URL: "https://x.example.com" })).toEqual([]); // nothing saved to override
    expect(envOverrideWarnings(written, {})).toEqual([]);
  });
});
