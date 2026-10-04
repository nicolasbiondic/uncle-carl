// ═══ SecretBox — symmetric secret storage for the self-hosted platform ═══
//
// AES-256-GCM with a per-value random 12-byte IV, serialized as a versioned
// string:  "v1.<iv>.<tag>.<ct>"  — each part base64url (no padding).
// The master key comes from (in order):
//   1. UC_MASTER_KEY env — 32 bytes, base64/base64url or hex encoded;
//   2. <dataDir>/master.key — same encodings, written 0600 by `bun run setup`.
// With neither present getSecretBox() throws a message pointing at
// `bun run setup` (which generates master.key and never overwrites it).
//
// Security invariants (locked by src/platform/secretBox.test.ts):
//   - roundtrip: open(seal(x)) === x;
//   - any tampering with iv/tag/ct, a wrong key, or a malformed/unknown
//     format throws — it never returns garbage plaintext;
//   - error messages NEVER include plaintext or key material.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { instanceDataDir } from "./instance";

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(s: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`SecretBox: malformed ${label} segment`);
  return Buffer.from(s, "base64url");
}

export function createSecretBox(key: Uint8Array): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new Error(`SecretBox: key must be exactly ${KEY_BYTES} bytes (got ${key.length})`);
  }
  // Private copy — a caller later zeroing its buffer can't corrupt the box.
  // (`as any`: the repo's stale @types/node Buffer.from lacks the Uint8Array overload.)
  const k = Buffer.from(key as any);

  return {
    seal(plaintext: string): string {
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
    },

    open(sealed: string): string {
      if (typeof sealed !== "string") throw new Error("SecretBox: sealed value must be a string");
      const parts = sealed.split(".");
      if (parts.length !== 4) throw new Error("SecretBox: malformed sealed value");
      const [version, ivS, tagS, ctS] = parts;
      if (version !== VERSION) throw new Error(`SecretBox: unsupported version "${version}"`);
      const iv = fromB64url(ivS, "iv");
      const tag = fromB64url(tagS, "tag");
      // NOTE: an empty ciphertext segment is legal (sealing "" produces it).
      const ct = ctS === "" ? Buffer.alloc(0) : fromB64url(ctS, "ciphertext");
      if (iv.length !== IV_BYTES) throw new Error("SecretBox: bad iv length");
      if (tag.length !== TAG_BYTES) throw new Error("SecretBox: bad tag length");
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      } catch {
        // Deliberately generic: never echoes the sealed value, the key, or
        // any partial plaintext.
        throw new Error("SecretBox: decryption failed (tampered data or wrong key)");
      }
    },
  };
}

// ── Master-key loading ─────────────────────────────────────────────────────

export function masterKeyPath(dataDir: string = instanceDataDir()): string {
  return path.join(dataDir, "master.key");
}

/** Decode a 32-byte key from base64 / base64url / hex. Null if not decodable. */
export function decodeMasterKey(raw: string): Uint8Array | null {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return Uint8Array.from(Buffer.from(t, "hex"));
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const buf = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length === KEY_BYTES) return Uint8Array.from(buf);
  }
  return null;
}

function loadMasterKey(): Uint8Array | null {
  const env = (process.env.UC_MASTER_KEY ?? "").trim();
  if (env !== "") {
    const key = decodeMasterKey(env);
    if (!key) throw new Error("SecretBox: UC_MASTER_KEY is set but is not a 32-byte base64/hex key");
    return key;
  }
  const p = masterKeyPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const key = decodeMasterKey(raw);
  if (!key) throw new Error(`SecretBox: ${p} exists but does not contain a 32-byte base64/hex key`);
  return key;
}

/** Is a master key available (env or file), without constructing a box? */
export function hasMasterKey(): boolean {
  try {
    return loadMasterKey() !== null;
  } catch {
    // Present but malformed = not usable; callers that then call
    // getSecretBox() get the precise error.
    return false;
  }
}

/** Box bound to the instance master key. Throws with setup guidance when
 *  no key is configured. NOT cached: the key read is cheap and tests /
 *  setup flows change it at runtime. */
export function getSecretBox(): SecretBox {
  const key = loadMasterKey();
  if (!key) {
    throw new Error(
      "SecretBox: no master key configured — run `bun run setup` (creates " +
      `${masterKeyPath()}), or set UC_MASTER_KEY to a 32-byte base64/hex key.`,
    );
  }
  return createSecretBox(key);
}
