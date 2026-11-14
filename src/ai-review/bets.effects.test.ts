// Stage C in the effect ledger (pre-registration §4 + amendment point 3): a bet day's effect = the fund's weight × the pass's equity × (the fund's
// open of the next session ÷ its open that session − 1), minus 10 bp per side once when the bet starts and once when it ends; its own kind of
// episode next to the exit of the stock (which stays as it is); pending while the fund's bars are missing; words verbatim.
import { describe, expect, test } from "bun:test";
import { buildLedger, renderLedger, type JournalPass } from "./effects";
import { buildHistory } from "./history";
import type { HeldPass } from "./journalDb";
import { parseHistory } from "./contract";
import { parseLedgerJson, weekSlice, weeklyMessage } from "./weekly";

const exitNvda = { symbol: "NVDA", action: "short", factor: 0, modelWeight: 0.5, appliedWeight: 0 };
const bet = (weight = 0.25, over: Record<string, unknown> = {}) => ({ underlying: "NVDA", symbol: "NVDD", weight, modelWeight: 0.5, stopped: false, ...over });
const rev = (bets: unknown[] | undefined, over: Record<string, unknown> = {}) => ({ aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied: true,
  effects: [exitNvda], modelWeights: { NVDA: 0.5 }, ...(bets ? { bets } : {}), ...over } });
// `held`: the book of the pass when it ran. By default the fund is there (the bet of the pass before was really bought).
const pass = (session: string, diagnostics: unknown = {}, equity = 10_000, sleeve = "momentum_stocks", held: string[] = ["NVDD"]): HeldPass => ({ sleeve, session, status: "submitted", equity, diagnostics, held });
const table = (t: Record<string, number>) => (symbol: string, session: string) => t[`${symbol}@${session}`] ?? null;

// The fund rises 1.6 % a day for three sessions: 2,500 × (3 × 0.016) = +$120. NVDA itself is flat (its exit is another episode).
const UP = table({ "NVDD@2026-11-16": 100, "NVDD@2026-11-17": 101.6, "NVDD@2026-11-18": 103.2256, "NVDD@2026-11-19": 104.8772096,
  "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 100, "NVDA@2026-11-18": 100, "NVDA@2026-11-19": 100 });
// … and falls 1.6 % a day for two sessions: 2,500 × (2 × −0.016) = −$80.
const DOWN = table({ "NVDD@2026-11-16": 100, "NVDD@2026-11-17": 98.4, "NVDD@2026-11-18": 96.8256 });
const threeDays = [pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()])), pass("2026-11-18", rev([bet()])), pass("2026-11-19")];

describe("the effect of a bet", () => {
  test("a gain: weight × equity × the fund's open-to-open return, day by day; costs once at the start and once at the end", () => {
    const l = buildLedger(threeDays as JournalPass[], UP);
    const e = l.applied.episodes.find(x => x.kind === "bet")!;
    expect(e).toMatchObject({ kind: "bet", fund: "NVDD", symbol: "NVDA", sleeve: "momentum_stocks", applied: true, startSession: "2026-11-16", lastSession: "2026-11-18",
      endSession: "2026-11-19", endedBy: "model", pendingDays: 0, savedUsd: 0, missedUsd: 0 });
    expect(e.days.map(d => [d.session, d.nextSession, d.modelWeight, d.appliedWeight, d.open, d.nextOpen])).toEqual([
      ["2026-11-16", "2026-11-17", 0, 0.25, 100, 101.6], ["2026-11-17", "2026-11-18", 0, 0.25, 101.6, 103.2256], ["2026-11-18", "2026-11-19", 0, 0.25, 103.2256, 104.8772096]]);
    for (const d of e.days) expect(d.effectUsd).toBeCloseTo(2500 * 0.016, 9);
    expect(e.effectUsd).toBeCloseTo(120, 9);
    expect(e).toMatchObject({ startCostUsd: 2.5, endCostUsd: 2.5, costUsd: 5 });       // 10 bp of $2,500, twice, not once per day
    expect(e.netUsd).toBeCloseTo(115, 9);
  });

  test("a loss: the fund fell, the effect is negative", () => {
    const l = buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()])), pass("2026-11-18")] as JournalPass[], DOWN);
    const e = l.applied.episodes.find(x => x.kind === "bet")!;
    expect(e.effectUsd).toBeCloseTo(-80, 9);
    expect(e.netUsd).toBeCloseTo(-85, 9);
  });

  test("pending while the fund's bars are missing: no money, still a case (the stock's own exit is measured on its own bars)", () => {
    const l = buildLedger(threeDays as JournalPass[], table({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 100, "NVDA@2026-11-18": 100, "NVDA@2026-11-19": 100 }));
    const e = l.applied.episodes.find(x => x.kind === "bet")!;
    expect(e.days.every(d => d.effectUsd === null && d.returnPct === null)).toBe(true);
    expect(e).toMatchObject({ pendingDays: 3, effectUsd: 0 });
    expect(l.applied.pendingCases).toBe(3);                                              // the 3 bet days; the exit's 3 days are measured (NVDA has bars)
    const partly = buildLedger(threeDays as JournalPass[], table({ "NVDD@2026-11-16": 100, "NVDD@2026-11-17": 101.6, "NVDD@2026-11-18": 103.2256 }));
    expect(partly.applied.episodes.find(x => x.kind === "bet")).toMatchObject({ pendingDays: 1 });
  });

  test("the bets' pending count and the exit's pending count are separate: NVDA's own bars keep the exit measured", () => {
    const l = buildLedger(threeDays as JournalPass[], table({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 95, "NVDA@2026-11-19": 95 }));
    const exit = l.applied.episodes.find(x => x.kind !== "bet")!;
    expect(exit).toMatchObject({ symbol: "NVDA", action: "short", pendingDays: 0 });
    expect(l.applied.pendingCases).toBe(3);
  });

  test("an episode that is still going pays only its start (no end yet); a one-day bet pays both", () => {
    const going = buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()]))] as JournalPass[], UP).applied.episodes.find(x => x.kind === "bet")!;
    expect(going).toMatchObject({ endSession: null, endedBy: null, startCostUsd: 2.5, endCostUsd: 0, costUsd: 2.5 });
    const one = buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17")] as JournalPass[], UP).applied.episodes.find(x => x.kind === "bet")!;
    expect(one).toMatchObject({ startCostUsd: 2.5, endCostUsd: 2.5, costUsd: 5 });
  });

  test("the cost follows the weight and the equity of the pass: the end is paid on the ending pass's equity", () => {
    const e = buildLedger([pass("2026-11-16", rev([bet(0.125)]), 20_000), pass("2026-11-17", {}, 24_000)] as JournalPass[], UP).applied.episodes.find(x => x.kind === "bet")!;
    expect(e.startCostUsd).toBeCloseTo(0.001 * 0.125 * 20_000, 9);
    expect(e.endCostUsd).toBeCloseTo(0.001 * 0.125 * 24_000, 9);
  });

  test("the stop: a pass where the bet is stopped (weight 0) is not a bet day; it ends the episode and pays the end", () => {
    const l = buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()])), pass("2026-11-18", rev([bet(0, { stopped: true })]))] as JournalPass[], UP);
    const e = l.applied.episodes.find(x => x.kind === "bet")!;
    expect(e).toMatchObject({ lastSession: "2026-11-17", endSession: "2026-11-18", endedBy: "model", endCostUsd: 2.5 });
    expect(e.days).toHaveLength(2);
  });

  test("a bet that stops and starts again is two episodes; two bets in two sleeves are two episodes", () => {
    const l = buildLedger([
      pass("2026-11-16", rev([bet()])), pass("2026-11-17"), pass("2026-11-18", rev([bet()])),
      pass("2026-11-16", rev([{ ...bet(), underlying: "AVGO", symbol: "AVS" }], { effects: [{ ...exitNvda, symbol: "AVGO" }] }), 10_000, "meanrev_stocks"),
    ] as JournalPass[], UP);
    const bets = l.applied.episodes.filter(x => x.kind === "bet");
    expect(bets.map(x => [x.sleeve, x.fund, x.startSession, x.endSession])).toEqual([
      ["momentum_stocks", "NVDD", "2026-11-16", "2026-11-17"], ["meanrev_stocks", "AVS", "2026-11-16", null], ["momentum_stocks", "NVDD", "2026-11-18", null]]);
  });

  test("only an APPLIED pass carries a bet: a record that says it only informed counts no bet", () => {
    const l = buildLedger([pass("2026-11-16", rev([bet()], { applied: false, modelWeights: undefined })), pass("2026-11-17")] as JournalPass[], UP);
    expect(l.applied.episodes.filter(x => x.kind === "bet")).toEqual([]);
    expect(l.hypothetical.episodes.filter(x => x.kind === "bet")).toEqual([]);
  });

  test("a bet day counts only when the fund was really bought: the NEXT pass's book must hold it", () => {
    // The journal of 11-16 aimed at the bet, but the next morning's book has no fund (the broker rejected the buy, or the risk gate skipped it):
    // that day made and lost nothing. The buy went through on 11-17 (11-18's book holds it): the episode starts there.
    const l = buildLedger([
      pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()]), 10_000, "momentum_stocks", []), pass("2026-11-18", rev([bet()])), pass("2026-11-19"),
    ] as JournalPass[], UP);
    const bets = l.applied.episodes.filter(x => x.kind === "bet");
    expect(bets.map(x => [x.startSession, x.lastSession, x.endSession, x.days.length])).toEqual([["2026-11-17", "2026-11-18", "2026-11-19", 2]]);
    expect(bets[0].effectUsd).toBeCloseTo(2 * 2500 * 0.016, 9);
    // never bought at all: no bet episode, and the exit of the stock is still there
    const never = buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()]), 10_000, "momentum_stocks", []), pass("2026-11-18", {}, 10_000, "momentum_stocks", [])] as JournalPass[], UP);
    expect(never.applied.episodes.filter(x => x.kind === "bet")).toEqual([]);
    expect(never.applied.episodes.filter(x => x.kind !== "bet").map(x => x.symbol)).toEqual(["NVDA"]);
  });

  test("the newest pass has no next book yet: its bet counts (pending); passes that do not say what they held take the journal's word", () => {
    const newest = buildLedger([pass("2026-11-16", rev([bet()]), 10_000, "momentum_stocks", [])] as JournalPass[], table({}));
    expect(newest.applied.episodes.find(x => x.kind === "bet")).toMatchObject({ startSession: "2026-11-16", endSession: null, pendingDays: 1 });
    const bare = (session: string, diagnostics: unknown = {}): JournalPass => ({ sleeve: "momentum_stocks", session, status: "submitted", equity: 10_000, diagnostics });
    const old = buildLedger([bare("2026-11-16", rev([bet()])), bare("2026-11-17", rev([bet()])), bare("2026-11-18")], UP);
    expect(old.applied.episodes.find(x => x.kind === "bet")!.days).toHaveLength(2);
  });

  test("next to the exit of the stock, which stays as it is: two episodes, the exit's saved/missed untouched, the bet in its own total", () => {
    const l = buildLedger(threeDays as JournalPass[], table({ "NVDD@2026-11-16": 100, "NVDD@2026-11-17": 101.6, "NVDD@2026-11-18": 103.2256, "NVDD@2026-11-19": 104.8772096,
      "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 95, "NVDA@2026-11-19": 95 }));
    const [exit, betEp] = [l.applied.episodes.find(x => x.kind !== "bet")!, l.applied.episodes.find(x => x.kind === "bet")!];
    expect(exit).toMatchObject({ symbol: "NVDA", action: "short", missedUsd: 0 });
    expect(exit.savedUsd).toBeCloseTo(0.5 * 10_000 * 0.05, 9);                          // the exit's $250 is what it always was
    expect(l.applied).toMatchObject({ decisions: 2, cases: 6, pendingCases: 0 });
    expect(l.applied.savedUsd).toBeCloseTo(exit.savedUsd, 9);
    expect(l.applied.betUsd).toBeCloseTo(120, 9);
    expect(l.applied.costUsd).toBeCloseTo(exit.costUsd + 5, 9);
    expect(l.applied.netUsd).toBeCloseTo(exit.netUsd + betEp.netUsd, 9);
  });
});

describe("the words, verbatim", () => {
  const l = () => buildLedger(threeDays as JournalPass[], UP);
  test("the ledger's line for a bet that went well, and its summary with the bets named apart", () => {
    const text = renderLedger(l());
    expect(text).toContain("• Nvidia (NVDA), Momentum Acciones: apostó contra ella del lunes 16 nov al miércoles 18 nov (3 días) · ganó $120 · operar costó $5");
    expect(text).toContain("las apuestas ganaron $120; operar costó");
    expect(text).not.toContain("NVDD");                                                // the owner reads the stock, never the fund's ticker
  });
  test("a bet that lost, one still going, one still pending", () => {
    const lost = renderLedger(buildLedger([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()])), pass("2026-11-18")] as JournalPass[], DOWN));
    expect(lost).toContain("apostó contra ella del lunes 16 nov al martes 17 nov (2 días) · perdió $80 · operar costó $5");
    expect(lost).toContain("las apuestas perdieron $80");
    const going = renderLedger(buildLedger([pass("2026-11-16", rev([bet()]))] as JournalPass[], UP));
    expect(going).toContain("apostó contra ella desde el lunes 16 nov (sigue, 1 día) · ganó $40 · operar costó $3");
    const pending = renderLedger(buildLedger(threeDays as JournalPass[], table({})));
    expect(pending).toContain("apostó contra ella del lunes 16 nov al miércoles 18 nov (3 días) · resultado pendiente · operar costó $5");
    expect(pending).toContain("todavía no hay precios para medir el efecto");
  });
  test("a ledger with no bets reads exactly as before (no `apuestas` anywhere)", () => {
    const text = renderLedger(buildLedger([pass("2026-11-16", { aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied: true, effects: [exitNvda] } }), pass("2026-11-17")] as JournalPass[],
      table({ "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95 })));
    expect(text).not.toContain("apuesta");
    expect(text).toContain("evitó $250 de pérdidas y dejó de ganar $0");
  });
});

describe("the analysts' history: an episode with action `bet`", () => {
  const universes = { momentum_stocks: ["NVDA"], meanrev_stocks: ["AVGO"] };
  test("the bet is its own episode next to the stock's exit, effects in whole dollars, the totals include what the bet made", () => {
    const h = buildHistory({ session: "2026-11-23", passes: threeDays, opens: UP, universes })!;
    expect(h.episodes.map(e => [e.symbol, e.action, e.from, e.to, e.sessions, e.effectUsd])).toEqual([
      ["NVDA", "bet", "2026-11-16", "2026-11-18", 3, 120],
      ["NVDA", "short", "2026-11-16", "2026-11-18", 3, 0]]);
    expect(h).toMatchObject({ savedUsd: 120, costUsd: 15, netUsd: 105 });                // 120 from the bet, 0 from the flat stock; costs: the exit's 2 × $5 and the bet's 2 × $2.50
    expect(parseHistory(JSON.parse(JSON.stringify(h))).ok).toBe(true);                   // the strict reader of the case file accepts `bet`
  });
  test("parseHistory refuses any other word", () => {
    const h = buildHistory({ session: "2026-11-23", passes: threeDays, opens: UP, universes })!;
    expect(parseHistory({ ...h, episodes: [{ ...h.episodes[0], action: "bat" }] }).ok).toBe(false);
  });
});

describe("the weekly message", () => {
  const WEEK = { start: "2026-11-16", end: "2026-11-20" };
  function weekly(passes: HeldPass[], opens = UP) {
    const ledger = buildLedger(passes as JournalPass[], opens);
    const parsed = parseLedgerJson(JSON.stringify({ generatedAt: "2026-11-21T14:30:00.000Z", ...ledger, misses: [] }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }
  test("`Apostó contra Nvidia (NVDA) 3 días: ganó $120.` and, for a loss, `perdió $80.`; the bets' own words in the summary", () => {
    const msg = weeklyMessage({ data: weekly(threeDays), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(msg).toContain("Apostó contra Nvidia (NVDA) 3 días: ganó $120.");
    expect(msg).toContain("las apuestas ganaron $120");
    const lost = weeklyMessage({ data: weekly([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()])), pass("2026-11-18")], DOWN), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(lost).toContain("Apostó contra Nvidia (NVDA) 2 días: perdió $80.");
    const going = weeklyMessage({ data: weekly([pass("2026-11-16", rev([bet()])), pass("2026-11-17", rev([bet()]))]), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(going).toContain("Apostó contra Nvidia (NVDA) 2 días (sigue): ganó");
    const pending = weeklyMessage({ data: weekly(threeDays, table({})), week: WEEK, adjustments: [], agent: { kind: "ok" } });
    expect(pending).toContain("Apostó contra Nvidia (NVDA) 3 días: resultado pendiente.");
  });
  test("the weekly slice keeps the bet apart (its gain is never an avoided loss) and the weeks add up with the bets", () => {
    const d = weekly(threeDays);
    const slice = weekSlice(d.applied, WEEK);
    expect(slice.block.savedUsd).toBeCloseTo(d.applied.savedUsd, 9);
    expect(slice.block.betUsd).toBeCloseTo(120, 9);
    expect(slice.block.netUsd).toBeCloseTo(d.applied.netUsd, 9);
    const betEpisode = slice.episodes.find(e => e.kind === "bet")!;
    expect(betEpisode).toMatchObject({ savedUsd: 0, missedUsd: 0 });
  });
  test("a report from before stage C (no betUsd, no kind) still reads, and a forged kind or betUsd does not", () => {
    const d = weekly(threeDays);
    const old = JSON.parse(JSON.stringify({ applied: d.applied, misses: [] }));
    delete old.applied.betUsd;
    for (const e of old.applied.episodes) delete e.kind;
    expect(parseLedgerJson(JSON.stringify(old)).ok).toBe(true);
    const forged = JSON.parse(JSON.stringify({ applied: d.applied, misses: [] }));
    forged.applied.episodes[0].kind = "gift";
    expect(parseLedgerJson(JSON.stringify(forged)).ok).toBe(false);
    const badBet = JSON.parse(JSON.stringify({ applied: d.applied, misses: [] }));
    badBet.applied.betUsd = "lots";
    expect(parseLedgerJson(JSON.stringify(badBet)).ok).toBe(false);
  });
});
