import { describe, expect, test } from "bun:test";
import { PAGE_IDS, isAliasHash, normalizePage, pageFromHash } from "./router.js";

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
    expect(pageFromHash("#/constructor")).toBeNull(); // no prototype keys
  });
  test("trailing segments are tolerated (#/ajustes?x=1)", () => {
    expect(pageFromHash("#/ajustes?x=1")).toBe("ajustes");
  });
});

describe("broker accounts live inside Ajustes (owner, 2026-10-11)", () => {
  test("Cuentas is no longer a page of its own", () => {
    expect(PAGE_IDS).not.toContain("cuentas");
  });
  test("old #/cuentas links and bookmarks land on Ajustes", () => {
    expect(pageFromHash("#/cuentas")).toBe("ajustes");
    expect(pageFromHash("#/cuentas?x=1")).toBe("ajustes");
    expect(isAliasHash("#/cuentas")).toBe(true);
    expect(isAliasHash("#/ajustes")).toBe(false);
  });
  test("a remembered 'cuentas' page is normalized; garbage falls back to Resumen", () => {
    expect(normalizePage("cuentas")).toBe("ajustes");
    expect(normalizePage("actividad")).toBe("actividad");
    expect(normalizePage("nope")).toBe("resumen");
    expect(normalizePage(undefined)).toBe("resumen");
  });
});
