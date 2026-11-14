// Shared fixtures for the AI review tests (no network, no database).
import { SLEEVE_NAMES, type CaseFile, type CaseSymbol, type Decision, type ModelVerdict, type Verdict } from "./contract";

export const SESSION = "2026-11-16";

export function sym(symbol: string, over: Partial<CaseSymbol> = {}): CaseSymbol {
  return {
    symbol, name: symbol, held: false, positionUsd: null, sinceEntryUsd: null, daysHeld: null, lastClose: 100,
    ret1dPct: 0.5, ret5dPct: -1.2, preMarket: null,
    news: [{ at: "2026-11-15T14:00:00.000Z", source: "Benzinga", headline: `${symbol} routine headline`, summary: "Nothing new.", url: `https://example.com/${symbol}/1` }],
    ...over,
  };
}

export const MOMENTUM = ["NVDA", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "IWM", "SSO", "QLD", "UGL", "USD"];
export const MEANREV = ["ABBV", "AVGO", "BAC", "CAT", "COST", "CVX", "DIS", "GE", "HD", "HON", "JNJ", "JPM", "KO", "LLY", "MA", "MCD", "MRK", "NFLX", "NKE", "ORCL", "PG", "QCOM", "UNH", "V", "WMT", "XLE", "XLF", "XLI", "XLP", "XLV", "XOM", "SLV"];

export function caseFile(over: Partial<CaseFile> = {}): CaseFile {
  return {
    session: SESSION,
    builtAt: "2026-11-16T13:10:00.000Z",
    sleeves: [
      { id: "momentum_stocks", name: SLEEVE_NAMES.momentum_stocks, valueUsd: 43677, symbols: MOMENTUM.map(s => sym(s, s === "NVDA" ? { held: true, positionUsd: 5200, sinceEntryUsd: -193, daysHeld: 4 } : {})) },
      { id: "meanrev_stocks", name: SLEEVE_NAMES.meanrev_stocks, valueUsd: 20000, symbols: MEANREV.map(s => sym(s)) },
    ],
    ...over,
  };
}

export const v = (action: Verdict["action"], confidence: number, extra: Partial<Verdict> = {}): Verdict => ({
  action, confidence, reason: action === "keep" ? "" : `Motivo de ${action}.`, sources: action === "keep" ? [] : [`https://news.example/${action}-${confidence}`], ...extra,
});

export const verdict = (verdicts: Record<string, Verdict>, session = SESSION): ModelVerdict => ({ session, verdicts });

export const baseDecision = (over: Partial<Omit<Decision, "id">> = {}): Omit<Decision, "id"> => ({
  session: SESSION, decidedAt: "2026-11-16T13:15:00.000Z", stage: "inform",
  models: [
    { model: "anthropic/claude-sonnet-5-5", family: "claude", ok: true, error: null, searched: true },
    { model: "codex/gpt-6.1-sol", family: "gpt", ok: true, error: null, searched: false },
    { model: "antigravity/gemini-3.8-flash-high", family: "gemini", ok: true, error: null, searched: true },
  ],
  overrides: [], dropped: [], reviewed: 43, ...over,
});
