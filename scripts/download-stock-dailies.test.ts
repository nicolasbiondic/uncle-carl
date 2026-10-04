import { describe, expect, test } from "bun:test";
import { mergeBarPages } from "./download-stock-dailies";

describe("mergeBarPages", () => {
  test("collects and orders bars from multiple pages for the same symbol", () => {
    const pages = [
      {
        AAPL: [
          { t: "2024-01-02T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000 },
          { t: "2024-01-03T00:00:00Z", o: 101, h: 102, l: 100, c: 101, v: 1000 },
        ],
      },
      {
        AAPL: [
          { t: "2024-01-01T00:00:00Z", o: 99, h: 100, l: 98, c: 99, v: 1000 },
          { t: "2024-01-04T00:00:00Z", o: 102, h: 103, l: 101, c: 102, v: 1000 },
        ],
      },
    ];

    const out = mergeBarPages(pages);
    expect(Object.keys(out)).toEqual(["AAPL"]);
    expect(out.AAPL.map(b => b.timestamp)).toEqual([
      Date.parse("2024-01-01T00:00:00Z"),
      Date.parse("2024-01-02T00:00:00Z"),
      Date.parse("2024-01-03T00:00:00Z"),
      Date.parse("2024-01-04T00:00:00Z"),
    ]);
    expect(out.AAPL.map(b => b.close)).toEqual([99, 100, 101, 102]);
  });

  test("keeps all bars for validation and merges across symbols", () => {
    const pages = [
      {
        AAPL: [{ t: "2024-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000 }],
        MSFT: [{ t: "2024-01-01T00:00:00Z", o: 200, h: 201, l: 199, c: 0, v: 1000 }],
      },
      {
        MSFT: [{ t: "2024-01-01T00:00:00Z", o: 200, h: 201, l: 199, c: 200, v: 1000 }],
      },
    ];

    const out = mergeBarPages(pages);
    expect(out.AAPL).toHaveLength(1);
    expect(out.MSFT).toHaveLength(2);
    expect(out.MSFT.map(b => b.close)).toEqual([0, 200]);
  });

  test("survives empty pages and missing symbols", () => {
    const out = mergeBarPages([{}, { AAPL: [] }, { TSLA: [{ t: "2024-01-01T00:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }] }]);
    expect(out.AAPL ?? []).toHaveLength(0);
    expect(out.TSLA).toHaveLength(1);
  });
});
