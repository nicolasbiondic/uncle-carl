import { describe, expect, test } from "bun:test";
import { fetchAlpacaStockBars } from "./AlpacaFetcher";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("fetchAlpacaStockBars pagination", () => {
  test("loads every page and forwards the next page token", async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? jsonResponse({ bars: { SPY: [{ t: "2024-01-02T14:30:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: "next" })
        : jsonResponse({ bars: { SPY: [{ t: "2024-01-02T14:35:00Z", o: 2, h: 3, l: 2, c: 3, v: 11 }] } });
    };

    const bars = await fetchAlpacaStockBars("SPY", "5m", 0, 1, { fetchFn, keyId: "key", secretKey: "secret" });

    expect(bars).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get("page_token")).toBe("next");
  });

  test("rejects a later page error instead of returning partial history", async () => {
    let calls = 0;
    const fetchFn = async () => ++calls === 1
      ? jsonResponse({ bars: { SPY: [{ t: "2024-01-02T14:30:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: "next" })
      : jsonResponse({ error: "rate limited" }, 429);

    await expect(fetchAlpacaStockBars("SPY", "5m", 0, 1, { fetchFn, keyId: "key", secretKey: "secret" }))
      .rejects.toThrow("429");
  });

  test("fails closed when the pagination cap is exhausted", async () => {
    const fetchFn = async () => jsonResponse({ bars: { SPY: [] }, next_page_token: "still-more" });
    await expect(fetchAlpacaStockBars("SPY", "5m", 0, 1, { fetchFn, keyId: "key", secretKey: "secret", maxPages: 1 }))
      .rejects.toThrow("pagination incomplete");
  });
});
