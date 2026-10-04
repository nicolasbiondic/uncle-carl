// ── Fear & Greed KPI (fng.js) — visual-only, but the mapping and the gauge
// math are still testable: bucket colors follow the alternative.me palette,
// the arc fill is proportional to the value, and the card renders/vanishes
// on data presence. The fetch itself is not tested (decoration, fails soft).
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { fngColor, fngLabel, renderFngKpi, _setFng, FNG_ARC_LEN } from "./fng.js";

const originalState = { ...store.state };
afterEach(() => { Object.assign(store.state, originalState); _setFng(null); });

describe("fngColor buckets (alternative.me palette)", () => {
  test("0-25 extreme fear is red, and 25 (the widget's own screenshot case) stays red", () => {
    expect(fngColor(0)).toBe("#ea3943");
    expect(fngColor(25)).toBe("#ea3943");
  });
  test("bucket edges: 26-45 fear, 46-55 neutral, 56-75 greed, 76+ extreme greed", () => {
    expect(fngColor(26)).toBe("#ff9800");
    expect(fngColor(45)).toBe("#ff9800");
    expect(fngColor(50)).toBe("#f3d42f");
    expect(fngColor(60)).toBe("#93d900");
    expect(fngColor(76)).toBe("#16c784");
    expect(fngColor(100)).toBe("#16c784");
  });
});

describe("fngLabel i18n", () => {
  test("es translates every upstream classification; en passes through", () => {
    store.state.lang = "es";
    expect(fngLabel("Extreme Fear")).toBe("Miedo extremo");
    expect(fngLabel("Greed")).toBe("Codicia");
    store.state.lang = "en";
    expect(fngLabel("Extreme Fear")).toBe("Extreme Fear");
  });
  test("an unknown upstream label falls back to itself, never undefined", () => {
    store.state.lang = "es";
    expect(fngLabel("Mystery Mood")).toBe("Mystery Mood");
  });
});

describe("renderFngKpi", () => {
  test("no data yet → empty string (no placeholder card in the strip)", () => {
    expect(renderFngKpi()).toBe("");
  });
  test("renders value, classification and a dasharray proportional to the value", () => {
    _setFng({ value: 25, label: "Extreme Fear" });
    const html = renderFngKpi();
    expect(html).toContain(">25<");
    expect(html).toContain("Extreme Fear");
    expect(html).toContain("#ea3943");
    const expected = ((25 / 100) * FNG_ARC_LEN).toFixed(2);
    expect(html).toContain(`stroke-dasharray="${expected} `);
  });
  test("value 100 fills the whole arc, no overflow past the track length", () => {
    _setFng({ value: 100, label: "Extreme Greed" });
    const html = renderFngKpi();
    expect(html).toContain(`stroke-dasharray="${FNG_ARC_LEN.toFixed(2)} ${FNG_ARC_LEN.toFixed(2)}"`);
  });
});
