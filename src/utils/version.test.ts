import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getVersionInfo } from "./version";

// require("fs") dodges bun-types' fs shim, which omits rmSync and the
// recursive-mkdirSync overload from its typings (same workaround already
// used in smoke.test.ts / pruneTransitionInvariance.test.ts).
function mkdirRecursive(path: string): void {
  require("fs").mkdirSync(path, { recursive: true });
}
function rmRecursive(path: string): void {
  try { require("fs").rmSync(path, { recursive: true, force: true }); } catch {}
}

function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "uc-version-test-"));
  mkdirRecursive(join(dir, ".git"));
  return dir;
}

describe("getVersionInfo", () => {
  test("reads the short commit hash via a branch ref (the normal case)", () => {
    const dir = makeFakeRepo();
    try {
      const hash = "93bfc1aadfb5e64d7c267e1d4e479b18cdcecbdc";
      mkdirRecursive(join(dir, ".git", "refs", "heads"));
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
      writeFileSync(join(dir, ".git", "refs", "heads", "master"), hash + "\n");

      const info = getVersionInfo(dir);
      expect(info.commit).toBe("93bfc1a");
    } finally {
      rmRecursive(dir);
    }
  });

  test("falls back to packed-refs when the loose ref file is missing", () => {
    const dir = makeFakeRepo();
    try {
      const hash = "deadbeef00112233445566778899aabbccddeeff";
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
      // No .git/refs/heads/master file — only packed.
      writeFileSync(join(dir, ".git", "packed-refs"), `# pack-refs\n${hash} refs/heads/master\n`);

      const info = getVersionInfo(dir);
      expect(info.commit).toBe("deadbee");
    } finally {
      rmRecursive(dir);
    }
  });

  test("reads a detached HEAD (HEAD file holds the hash directly)", () => {
    const dir = makeFakeRepo();
    try {
      const hash = "1234567890abcdef1234567890abcdef12345678";
      writeFileSync(join(dir, ".git", "HEAD"), hash + "\n");

      const info = getVersionInfo(dir);
      expect(info.commit).toBe("1234567");
    } finally {
      rmRecursive(dir);
    }
  });

  test("missing .git directory: commit is 'unknown', never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-version-test-nogit-"));
    try {
      expect(() => getVersionInfo(dir)).not.toThrow();
      const info = getVersionInfo(dir);
      expect(info.commit).toBe("unknown");
      expect(info.dirty).toBeNull();
    } finally {
      rmRecursive(dir);
    }
  });

  test("corrupted/garbage HEAD file: commit is 'unknown', never throws", () => {
    const dir = makeFakeRepo();
    try {
      writeFileSync(join(dir, ".git", "HEAD"), "not a valid HEAD file at all\n");
      expect(() => getVersionInfo(dir)).not.toThrow();
      expect(getVersionInfo(dir).commit).toBe("unknown");
    } finally {
      rmRecursive(dir);
    }
  });

  test("HEAD points at a ref with no loose file and no packed-refs entry: 'unknown'", () => {
    const dir = makeFakeRepo();
    try {
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/nonexistent\n");
      expect(getVersionInfo(dir).commit).toBe("unknown");
    } finally {
      rmRecursive(dir);
    }
  });

  test("startedAt is captured as a real epoch ms timestamp", () => {
    const before = Date.now();
    const info = getVersionInfo(process.cwd());
    expect(info.startedAt).toBeGreaterThanOrEqual(before);
    expect(info.startedAt).toBeLessThanOrEqual(Date.now() + 5);
  });
});
