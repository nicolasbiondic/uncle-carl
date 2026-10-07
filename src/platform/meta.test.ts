import { describe, expect, test } from "bun:test";
import { makeTestDb } from "../test-support/db";
import { accountIdFor, getInstanceId, getPlatformMeta, setPlatformMeta } from "./meta";

describe("platform_meta", () => {
  test("get/set round-trip and upsert", () => {
    makeTestDb();
    expect(getPlatformMeta("x")).toBeNull();
    setPlatformMeta("x", "1");
    expect(getPlatformMeta("x")).toBe("1");
    setPlatformMeta("x", "2");
    expect(getPlatformMeta("x")).toBe("2");
  });

  test("getInstanceId mints a UUID once and then always returns it", () => {
    makeTestDb();
    const a = getInstanceId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getInstanceId()).toBe(a);
    expect(getPlatformMeta("instance_id")).toBe(a);
  });

  test("a fresh database mints a DIFFERENT instance id", () => {
    makeTestDb();
    const a = getInstanceId();
    makeTestDb();
    const b = getInstanceId();
    expect(b).not.toBe(a);
  });
});

describe("accountIdFor", () => {
  test("acct_ + 12 hex, deterministic, user- and instance-sensitive", () => {
    const id = accountIdFor("instance-1", "owner");
    expect(id).toMatch(/^acct_[0-9a-f]{12}$/);
    expect(accountIdFor("instance-1", "owner")).toBe(id);
    expect(accountIdFor("instance-1", "viewer")).not.toBe(id);
    expect(accountIdFor("instance-2", "owner")).not.toBe(id);
  });
});
