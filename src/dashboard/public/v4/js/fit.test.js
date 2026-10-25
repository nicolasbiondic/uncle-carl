import { expect, test } from "bun:test";
import { fitTable } from "./fit.js";

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
