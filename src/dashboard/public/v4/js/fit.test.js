import { expect, test } from "bun:test";
import { fitTable, fitStrip } from "./fit.js";

// A table that needs `need[k]` px with k groups hidden, in a box `client` px wide.
function fakeBox(need, client) {
  const cls = new Set();
  const table = { classList: { add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)) } };
  return { cls, clientWidth: client, get scrollWidth() { return need[cls.size] ?? need.at(-1); }, querySelector: () => table };
}

test("hides groups in order only while the table overflows its box", () => {
  const box = fakeBox([803, 760, 700], 794); // 8px scrollbar took the last pixel
  expect(fitTable(box, ["fit-1", "fit-2"], true)).toBe(1);
  expect([...box.cls]).toEqual(["fit-1"]);
});

test("a table that fits keeps every column; a re-fit starts from none hidden", () => {
  const box = fakeBox([700], 794);
  box.cls.add("fit-2");
  expect(fitTable(box, ["fit-1", "fit-2"], true)).toBe(0);
  expect(box.cls.size).toBe(0);
});

test("phones keep their sideways scroll", () => {
  const box = fakeBox([900, 800], 400);
  expect(fitTable(box, ["fit-1", "fit-2"], false)).toBe(0);
});

// The KPI strip: sparklines first (fit-1), then the win rate (fit-2).
test("the KPI strip drops the sparklines, then the win rate, only while it overflows", () => {
  const strip = fakeStrip([1500, 1380, 1290], 1400);
  expect(fitStrip(strip, ["fit-1", "fit-2"], true)).toBe(1);
  expect([...strip.cls]).toEqual(["fit-1"]);
  const tight = fakeStrip([1500, 1450, 1390], 1400);
  expect(fitStrip(tight, ["fit-1", "fit-2"], true)).toBe(2);
  expect([...tight.cls]).toEqual(["fit-1", "fit-2"]);
});

test("a strip that fits keeps everything; a re-fit starts clean; phones keep their sideways scroll", () => {
  const strip = fakeStrip([1300], 1400);
  strip.cls.add("fit-2");
  expect(fitStrip(strip, ["fit-1", "fit-2"], true)).toBe(0);
  expect(strip.cls.size).toBe(0);
  expect(fitStrip(fakeStrip([900, 800], 400), ["fit-1", "fit-2"], false)).toBe(0);
  expect(fitStrip(null, undefined, true)).toBe(0);
});

function fakeStrip(need, client) {
  const cls = new Set();
  return { cls, clientWidth: client, get scrollWidth() { return need[cls.size] ?? need.at(-1); }, classList: { add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)) } };
}
