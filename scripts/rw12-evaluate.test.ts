// RW12 (docs/reports/RW-reescritura-rentable.md §23): the two pre-registered criteria as written there.
// Pure arithmetic over figures; no data and no trial.
import { describe, expect, test } from "bun:test";
import { criterionC, criterionH } from "./rw12-evaluate";

describe("criterion H (stocks: the hedge with its own cap)", () => {
  const ok = { cagr: 0.28, controlCagr: 0.316, accountDrawdown: 0.31, maxGross: 2.72 };

  test("all four pass: wired", () => {
    const r = criterionH(ok);
    expect(r.failed).toEqual([]);
    expect(r.wire).toBe(true);
    expect(r.verdict).toBe("CUMPLE: se cablea");
  });

  test("H1 is strict: a CAGR of exactly zero fails", () => {
    expect(criterionH({ ...ok, cagr: 0, controlCagr: 0.04 }).failed).toEqual(["H1_positive"]);
    expect(criterionH({ ...ok, cagr: 0.0001, controlCagr: 0.04 }).failed).toEqual([]);
  });

  test("H2: the stock account may fall 35 %, not more", () => {
    expect(criterionH({ ...ok, accountDrawdown: 0.35 }).failed).toEqual([]);
    expect(criterionH({ ...ok, accountDrawdown: 0.3501 }).failed).toEqual(["H2_accountDrawdown"]);
  });

  test("H3: a cost of 5 points of CAGR passes, more does not; a candidate ABOVE its control has no cost", () => {
    expect(criterionH({ ...ok, cagr: 0.266, controlCagr: 0.316 }).failed).toEqual([]);
    expect(criterionH({ ...ok, cagr: 0.2659, controlCagr: 0.316 }).failed).toEqual(["H3_cost"]);
    expect(criterionH({ ...ok, cagr: 0.4, controlCagr: 0.316 }).criteria.H3_cost.pass).toBe(true);
  });

  test("H4: (max gross + 1.03) / 2 against the live account clip of 1.9", () => {
    expect(criterionH({ ...ok, maxGross: 2.77 }).failed).toEqual([]);          // 1.900
    expect(criterionH({ ...ok, maxGross: 2.78 }).failed).toEqual(["H4_executable"]); // 1.905
  });

  test("only H3 failing is the owner's call; any of H1, H2, H4 failing is a no", () => {
    const onlyCost = criterionH({ ...ok, cagr: 0.2, controlCagr: 0.316 });
    expect(onlyCost.wire).toBe(false);
    expect(onlyCost.verdict).toBe("SOLO FALLA H3: decide el dueño, no se cablea sin él");
    const costAndDrawdown = criterionH({ ...ok, cagr: 0.2, controlCagr: 0.316, accountDrawdown: 0.4 });
    expect(costAndDrawdown.wire).toBe(false);
    expect(costAndDrawdown.verdict).toBe("FALLA H2_accountDrawdown, H3_cost: no se cablea");
    expect(criterionH({ ...ok, cagr: -0.01, controlCagr: 0.02 }).verdict).toBe("FALLA H1_positive: no se cablea");
  });
});

describe("criterion C (crypto: a capped Turtle short is renewed)", () => {
  const ok = { cagr: 0.2, controlCagr: 0.168, trades: 3200, controlTrades: 3025, bookDrawdown: 0.24 };

  test("all four pass: wired", () => {
    const r = criterionC(ok);
    expect(r.failed).toEqual([]);
    expect(r.wire).toBe(true);
    expect(r.verdict).toBe("CUMPLE: se cablea");
  });

  test("C1: zero is allowed, a loss is not", () => {
    expect(criterionC({ ...ok, cagr: 0, controlCagr: -0.05 }).failed).toEqual([]);
    expect(criterionC({ ...ok, cagr: -0.0001, controlCagr: -0.05 }).failed).toEqual(["C1_nonNegative"]);
  });

  test("C2 and C4 are strict: the same trades or the same CAGR as the control is not 'more'", () => {
    expect(criterionC({ ...ok, trades: 3025 }).failed).toEqual(["C2_moreTrades"]);
    expect(criterionC({ ...ok, cagr: 0.168 }).failed).toEqual(["C4_beatsControl"]);
  });

  test("C3: the four-sleeve book may fall 35 %, not more", () => {
    expect(criterionC({ ...ok, bookDrawdown: 0.35 }).failed).toEqual([]);
    expect(criterionC({ ...ok, bookDrawdown: 0.36 }).failed).toEqual(["C3_book"]);
  });

  test("a candidate that loses money while trading more is refused, and the verdict says the sleeve stays", () => {
    const r = criterionC({ cagr: -0.16, controlCagr: 0.12, trades: 1560, controlTrades: 840, bookDrawdown: 0.2 });
    expect(r.wire).toBe(false);
    expect(r.failed).toEqual(["C1_nonNegative", "C4_beatsControl"]);
    expect(r.verdict).toBe("FALLA C1_nonNegative, C4_beatsControl: el sleeve sigue igual");
  });
});
