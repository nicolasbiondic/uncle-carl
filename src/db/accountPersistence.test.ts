import { beforeAll, describe, expect, test } from "bun:test";
import { loadAccount, saveAccount } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => makeTestDb());

describe("account allocation persistence", () => {
  test("updates initial equity when a sleeve allocation changes", () => {
    saveAccount("allocation_test", 100_000, 100_000, 100_000, 0);
    saveAccount("allocation_test", 50_000, 50_000, 50_000, 0);

    expect(loadAccount("allocation_test")?.initialEquity).toBe(50_000);
  });
});
