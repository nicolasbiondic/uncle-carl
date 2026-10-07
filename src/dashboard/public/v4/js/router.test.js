import { describe, expect, test } from "bun:test";
import { PAGE_IDS, pageFromHash } from "./router.js";

describe("pageFromHash", () => {
  test("every nav page round-trips", () => {
    for (const id of PAGE_IDS) expect(pageFromHash(`#/${id}`)).toBe(id);
  });
  test("unknown, empty and malformed hashes → null", () => {
    expect(pageFromHash("#/nope")).toBeNull();
    expect(pageFromHash("")).toBeNull();
    expect(pageFromHash(null)).toBeNull();
    expect(pageFromHash("#resumen")).toBeNull();
    expect(pageFromHash("#/RESUMEN")).toBeNull();
  });
  test("trailing segments are tolerated (#/cuentas?x=1)", () => {
    expect(pageFromHash("#/cuentas?x=1")).toBe("cuentas");
  });
});
