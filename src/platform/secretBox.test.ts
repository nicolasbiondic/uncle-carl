import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createSecretBox, getSecretBox, hasMasterKey, decodeMasterKey, masterKeyPath,
} from "./secretBox";
import { resetInstanceConfigForTests } from "./instance";

const ENV_KEYS = ["UC_MASTER_KEY", "UC_DATA_DIR"];
let saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-secretbox-"));
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

const KEY = crypto.randomBytes(32);
// Stale @types/node: its Buffer typing doesn't extend Uint8Array, so wrap
// explicitly for the createSecretBox(key: Uint8Array) signature.
const u8 = (b: Buffer): Uint8Array => Uint8Array.from(b);

describe("createSecretBox — seal/open", () => {
  test("roundtrip, including unicode and empty string", () => {
    const box = createSecretBox(u8(KEY));
    for (const pt of ["hello", "", "árbol-ñ-💸", "a".repeat(10_000), JSON.stringify({ k: "v" })]) {
      const sealed = box.seal(pt);
      expect(sealed.startsWith("v1.")).toBe(true);
      expect(box.open(sealed)).toBe(pt);
    }
  });

  test("sealed format is v1.<iv>.<tag>.<ct> base64url and never contains the plaintext", () => {
    const box = createSecretBox(u8(KEY));
    const sealed = box.seal("super-secret-broker-key");
    const parts = sealed.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    for (const p of parts.slice(1, 3)) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("super-secret-broker-key");
    expect(Buffer.from(parts[1], "base64url").length).toBe(12); // iv
    expect(Buffer.from(parts[2], "base64url").length).toBe(16); // gcm tag
  });

  test("same plaintext seals to different ciphertexts (random IV)", () => {
    const box = createSecretBox(u8(KEY));
    expect(box.seal("x")).not.toBe(box.seal("x"));
  });

  test("tampering with any segment throws", () => {
    const box = createSecretBox(u8(KEY));
    const sealed = box.seal("plain");
    const [v, iv, tag, ct] = sealed.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(() => box.open(`${v}.${flip(iv)}.${tag}.${ct}`)).toThrow();
    expect(() => box.open(`${v}.${iv}.${flip(tag)}.${ct}`)).toThrow();
    expect(() => box.open(`${v}.${iv}.${tag}.${flip(ct)}`)).toThrow();
  });

  test("wrong key throws (and the error leaks neither key nor plaintext)", () => {
    const sealed = createSecretBox(u8(KEY)).seal("plain-secret");
    const other = createSecretBox(u8(crypto.randomBytes(32)));
    try {
      other.open(sealed);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("decryption failed");
      expect(e.message).not.toContain("plain-secret");
      expect(e.message).not.toContain(KEY.toString("base64url"));
    }
  });

  test("malformed / unknown-version inputs throw", () => {
    const box = createSecretBox(u8(KEY));
    for (const bad of ["", "garbage", "v1.a.b", "v1.a.b.c.d", "v2.aaaa.bbbb.cccc", "v1.$$.!!.??"]) {
      expect(() => box.open(bad)).toThrow();
    }
  });

  test("key must be exactly 32 bytes", () => {
    expect(() => createSecretBox(u8(crypto.randomBytes(16)))).toThrow("32 bytes");
    expect(() => createSecretBox(u8(crypto.randomBytes(33)))).toThrow("32 bytes");
  });
});

describe("master key resolution (env > <dataDir>/master.key)", () => {
  test("no key anywhere: hasMasterKey false, getSecretBox throws pointing at setup", () => {
    expect(hasMasterKey()).toBe(false);
    expect(() => getSecretBox()).toThrow("bun run setup");
  });

  test("UC_MASTER_KEY env (base64) works", () => {
    process.env.UC_MASTER_KEY = KEY.toString("base64");
    expect(hasMasterKey()).toBe(true);
    const box = getSecretBox();
    expect(box.open(box.seal("s"))).toBe("s");
  });

  test("UC_MASTER_KEY env (hex) works and matches the same key", () => {
    process.env.UC_MASTER_KEY = KEY.toString("hex");
    const sealed = getSecretBox().seal("cross");
    expect(createSecretBox(u8(KEY)).open(sealed)).toBe("cross");
  });

  test("malformed UC_MASTER_KEY throws loudly (never silently downgrades)", () => {
    process.env.UC_MASTER_KEY = "tooshort";
    expect(hasMasterKey()).toBe(false);
    expect(() => getSecretBox()).toThrow("32-byte");
  });

  test("<dataDir>/master.key is used when env unset", () => {
    fs.writeFileSync(masterKeyPath(tmp), KEY.toString("base64") + "\n", { mode: 0o600 });
    expect(hasMasterKey()).toBe(true);
    const sealed = getSecretBox().seal("file-key");
    expect(createSecretBox(u8(KEY)).open(sealed)).toBe("file-key");
  });

  test("decodeMasterKey accepts base64, base64url and hex; rejects wrong sizes", () => {
    expect(decodeMasterKey(KEY.toString("base64"))).toEqual(Uint8Array.from(KEY));
    expect(decodeMasterKey(KEY.toString("base64url"))).toEqual(Uint8Array.from(KEY));
    expect(decodeMasterKey(KEY.toString("hex"))).toEqual(Uint8Array.from(KEY));
    expect(decodeMasterKey("abc")).toBeNull();
    expect(decodeMasterKey(crypto.randomBytes(16).toString("base64"))).toBeNull();
  });
});
