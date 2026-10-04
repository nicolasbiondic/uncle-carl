import { expect, test } from "bun:test";
import { getAlpacaV8StartEquity, getDB } from "./database";
import { makeTestDb } from "../test-support/db";

test("getAlpacaV8StartEquity returns the historical v2 anchor across the semantics bump", () => {
  makeTestDb();
  const anchor = Date.parse("2026-07-10T14:00:00Z");
  const insert = getDB().prepare(
    `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  insert.run("alpaca_main", 90_000, 90_000, 0, anchor - 1, 1);
  insert.run("alpaca_main", 100_000, 100_000, 0, anchor, 2);
  insert.run("alpaca_main", 95_000, 95_000, 0, anchor + 86_400_000, 3);

  expect(getAlpacaV8StartEquity()).toBe(100_000);
});
