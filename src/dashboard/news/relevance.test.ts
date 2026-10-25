import { describe, expect, test } from "bun:test";
import { NEWS_UNIVERSE, newsRelevance, rankNewsItems } from "./relevance";

const context = { heldSymbols: [] };

describe("deterministic news relevance", () => {
  test("every canonical universe ticker is recognized, without inventing membership from aliases", () => {
    for (const symbol of NEWS_UNIVERSE) {
      const base = symbol.split("/")[0];
      expect(newsRelevance(`$${base} reports results`, context)).toEqual({ tag: base, score: 2 });
    }
    expect(newsRelevance("TSLA reports earnings", context)).toBeNull();
  });

  test.each([
    ["Apple raises earnings guidance", "AAPL"], ["Nvidia earnings beat forecasts", "NVDA"],
    ["Microsoft announces cloud deal", "MSFT"], ["Eli Lilly reports trial results", "LLY"],
    ["Bitcoin rallies after ETF approval", "BTC"], ["Ether staking withdrawals rise", "ETH"],
    ["Solana network resumes", "SOL"], ["Dogecoin volume jumps", "DOGE"],
    ["Chainlink signs bank partnership", "LINK"], ["Litecoin upgrade activated", "LTC"],
    ["$nvda jumps in premarket trading", "NVDA"], ["(NVDA) gains on new orders", "NVDA"],
    ["JPMorgan aumenta beneficios", "JPM"],
  ])("keeps company/coin/cashtag: %s", (title, tag) => {
    expect(newsRelevance(title, context)).toEqual({ tag, score: 2 });
  });

  test.each([
    ["Fed leaves rates unchanged", "Fed"], ["FOMC announces rate decision", "Fed"],
    ["Powell signals rate cuts", "Fed"],
    ["La Reserva Federal recorta las tasas de interés", "Fed"],
    ["CPI inflation exceeds forecasts", "Inflation"], ["PCE prices ease", "Inflation"],
    ["La inflación sorprende al mercado", "Inflation"],
    ["Jobs report: payrolls fall", "Jobs"], ["GDP contracts as recession looms", "GDP"],
    ["New tariffs imposed on chip imports", "Trade"], ["Oil sanctions take effect", "Trade"],
    ["Regional bank failure sparks contagion", "Banks"], ["Banking crisis deepens", "Banks"],
    ["Regional bank collapses after deposit flight", "Banks"],
    ["SEC approves crypto ETFs", "Crypto"], ["Crypto regulation bill passes Senate", "Crypto"],
    ["SEC sues Coinbase over securities offerings", "Crypto"],
    ["Binance exchange hacked; withdrawals halted", "Crypto"], ["Exchange outage halts trading", "Crypto"],
    ["Caída de Binance suspende operaciones", "Crypto"],
    ["Nasdaq falls 3%", "Markets"], ["S&P 500 hits record", "Markets"],
    ["S&P 500 stocks plunge after disappointing report", "Markets"],
    ["Crude oil surges after supply disruption", "Oil"], ["OPEC announces production cut", "Oil"],
  ])("keeps market-moving topic: %s", (title, tag) => {
    expect(newsRelevance(title, context)).toEqual({ tag, score: 1 });
  });

  test.each([
    "My father-in-law, 81, sold his $75,000 home…", "My husband sold our Apple stock",
    "Should I buy NVDA?", "Can I retire with Bitcoin?", "I'm 65 and own Nvidia stock",
    "Retirement advice after the Fed rate cut", "Retirees: tips to save on inflation",
    "Your mortgage after the Fed decision", "First-time homebuyers face inflation",
    "Mi suegro vendió su casa para comprar Bitcoin", "Cómo invertir en Bitcoin",
    "7 stocks to buy after the CPI report", "Top 5 cryptos for the next Fed cut",
    "Three beaten-down stocks to buy: Nvidia leads", "I inherited Apple shares and need advice",
    "3 reasons Nvidia could double", "Best stocks for retirement: Apple and Nvidia",
    "Why you should buy Bitcoin now", "Bitcoin price prediction: get rich",
    "Nvidia is a buy for your portfolio", "Bitcoin price forecast for next year",
    "Opinion: Nvidia is the only stock you need", "Opinión: Bitcoin es el futuro",
    "Celebrity wedding funded with Bitcoin", "Horóscopo de hoy: Bitcoin y tu suerte",
    "Unrelated local politics", "A new link near the cathedral", "SCPI estimates revised",
    "NVDAx announces product", "ethernet hardware updated", "FedEx expands deliveries",
  ])("drops irrelevant/advice even with a held symbol: %s", title => {
    expect(newsRelevance(title, { heldSymbols: ["NVDA", "AAPL", "BTC/USD"] })).toBeNull();
  });

  test("normalizes all held crypto wallets, including COIN-M, and supports portfolio additions", () => {
    for (const symbol of ["BTC/USD", "BTC/USDC", "BTC/COIN-M", "BTCUSDT", "BTCUSD_PERP"]) {
      expect(newsRelevance("Bitcoin rallies", { heldSymbols: [symbol] })).toEqual({ tag: "BTC", score: 3 });
    }
    expect(newsRelevance("TLT rallies", { heldSymbols: [], tradedSymbols: ["TLT"] })).toEqual({ tag: "TLT", score: 2 });
    expect(newsRelevance("XYZ reports results", { heldSymbols: ["XYZ"] })).toEqual({ tag: "XYZ", score: 3 });
  });

  test("strongest match wins regardless of alias order, missing dates sort last within tier", () => {
    const items = [
      { title: "Fed cuts rates", pubDate: 999 },
      { title: "Nvidia and Apple rise", pubDate: null },
      { title: "NVDA guidance raised", pubDate: 1 },
      { title: "Ethereum rises", pubDate: 100 },
    ];
    expect(rankNewsItems(items, { heldSymbols: ["NVDA"] }).map(i => i.tag)).toEqual(["NVDA", "NVDA", "ETH", "Fed"]);
    expect(rankNewsItems(items, { heldSymbols: ["NVDA"] })[0].pubDate).toBe(1);
  });
});
