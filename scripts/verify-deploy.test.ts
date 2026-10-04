import { describe, expect, test } from "bun:test";
import { commitsMatch } from "./verify-deploy";

describe("commitsMatch", () => {
  test("matches when live and disk report the same commit", () => {
    expect(commitsMatch("93bfc1a", "93bfc1a")).toBe(true);
  });

  test("does NOT match on different commits — the zombie-process case", () => {
    expect(commitsMatch("aaaaaaa", "93bfc1a")).toBe(false);
  });

  test("does NOT match when the live response is missing a commit field", () => {
    expect(commitsMatch(undefined, "93bfc1a")).toBe(false);
    expect(commitsMatch(null, "93bfc1a")).toBe(false);
    expect(commitsMatch("", "93bfc1a")).toBe(false);
  });

  test("does NOT match when local commit is 'unknown' — refuses to claim a false positive", () => {
    expect(commitsMatch("unknown", "unknown")).toBe(false);
  });
});
