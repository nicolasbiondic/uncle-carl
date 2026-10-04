import { describe, expect, test } from "bun:test";
import { getETDayBounds } from "./database";

describe("ET day bounds", () => {
  test("uses a 23-hour range on the spring DST transition day", () => {
    const [start, end] = getETDayBounds("2026-03-08");
    expect(end - start).toBe(23 * 60 * 60_000);
  });

  test("uses a 25-hour range on the fall DST transition day", () => {
    const [start, end] = getETDayBounds("2026-11-01");
    expect(end - start).toBe(25 * 60 * 60_000);
  });
});
