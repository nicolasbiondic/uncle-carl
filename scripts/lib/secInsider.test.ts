/**
 * SEC insider data sets → signal_events. Synthetic fixtures only (no network,
 * no real filings): small TSV/zip files built here, in the data sets' layout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { deflateRawSync } from "node:zlib";
import {
  SEC_FORM4_BUY_SOURCE, buysToRows, buyKey, classifyInsider, dotForm, extractBuys, knownAtMsFor, listZip, mentionsPlan10b5, newBuildContext,
  parseCheckbox, parseRoles, primaryOwner, readZipText, resolveSymbol, secDateToIso, summarizeRows, tickerTokens, transactionKey, tsvRows,
  type TradeHistory,
} from "./secInsider";
import {
  SIGNAL_EVENTS_DDL, SignalBook, hashSignalEvents, loadSignalEvents, openSignalsDbForWrite, replaceSourceRows, type SignalRow,
} from "./signalData";

const dir = mkdtempSync(join(tmpdir(), "sec-insider-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── fixtures (the data sets' column names, a subset of the columns) ────────

const SUBMISSION = [
  "ACCESSION_NUMBER\tFILING_DATE\tPERIOD_OF_REPORT\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tREMARKS",
  // joint Form 4 of an officer and a director: one purchase, one sale, one grant
  '0000000001-15-000001\t30-MAR-2015\t26-MAR-2015\t4\t0000111111\tAcme Corp\tACME\t"See ""Note 1""\nsecond line of remarks"',
  // Form 4 by a 10% owner, class-share ticker, purchase without a price
  "0000000002-15-000002\t31-MAR-2015\t27-MAR-2015\t4\t0000222222\tBerk Holdings\tBRK-B\t",
  // amendment re-reporting the first purchase, filed later
  "0000000003-15-000003\t02-APR-2015\t26-MAR-2015\t4/A\t0000111111\tAcme Corp\tACME\t",
  // Form 5 with a P row: not source sec-form4-buy
  "0000000004-15-000004\t01-APR-2015\t31-DEC-2014\t5\t0000333333\tFive Inc\tFIVE\t",
  // issuer without a ticker
  "0000000005-15-000005\t01-APR-2015\t30-MAR-2015\t4\t0000444444\tPrivate Co\tNONE\t",
  // a second insider buys ACME three days later (same size and price as Alice: distinct owner, not a duplicate)
  "0000000006-15-000006\t03-APR-2015\t01-APR-2015\t4\t0000111111\tAcme Corp\tACME\t",
].join("\n") + "\n";

const OWNERS = [
  "ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE",
  "0000000001-15-000001\t0000900001\tAlice A\tOfficer\tChief Executive Officer",
  "0000000001-15-000001\t0000900002\tBob B\tDirector\t",
  "0000000002-15-000002\t0000900003\tCarol Capital LP\tTenPercentOwner\t",
  "0000000003-15-000003\t0000900001\tAlice A\tOfficer\tChief Executive Officer",
  "0000000003-15-000003\t0000900002\tBob B\tDirector\t",
  "0000000004-15-000004\t0000900004\tDan D\tDirector\t",
  "0000000005-15-000005\t0000900005\tEve E\tDirector,Officer\tCFO",
  "0000000006-15-000006\t0000900006\tFrank F\tDirector\t",
].join("\n") + "\n";

const TRANS_HEADER = "ACCESSION_NUMBER\tNONDERIV_TRANS_SK\tSECURITY_TITLE\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tTRANS_ACQUIRED_DISP_CD";
const TRANS = [
  TRANS_HEADER,
  "0000000001-15-000001\t1\tCommon Stock\t26-MAR-2015\tP\t1000.0\t10.00\tA",
  "0000000001-15-000001\t2\tCommon Stock\t26-MAR-2015\tS\t50.0\t11.00\tD",
  "0000000001-15-000001\t3\tCommon Stock\t26-MAR-2015\tA\t200.0\t0.0\tA",
  "0000000002-15-000002\t4\tClass B Common\t27-MAR-2015\tP\t500.0\t\tA",
  "0000000003-15-000003\t5\tCommon Stock\t26-MAR-2015\tP\t1000.0\t10.00\tA",
  "0000000004-15-000004\t6\tCommon Stock\t20-DEC-2014\tP\t10.0\t5.00\tA",
  "0000000005-15-000005\t7\tCommon Stock\t30-MAR-2015\tP\t10.0\t5.00\tA",
  "0000000006-15-000006\t8\tCommon Stock\t01-APR-2015\tP\t1000.0\t10.00\tA",
].join("\n") + "\n";

const MEMBERS = new Set(["ACME", "BRK.B"]);
const isMember = (s: string) => MEMBERS.has(s);

describe("TSV parsing", () => {
  test("quoted fields hold tabs, newlines and doubled quotes; CRLF and blank lines are tolerated", () => {
    const rows = [...tsvRows('a\tb\tc\r\n"x\ty"\t"he said ""hi""\nbye"\tlast\r\n\r\nz\t\t\n')];
    expect(rows).toEqual([["a", "b", "c"], ["x\ty", 'he said "hi"\nbye', "last"], ["z", "", ""]]);
  });
  test("a file without a final newline keeps its last row", () => {
    expect([...tsvRows("h1\th2\nv1\tv2")]).toEqual([["h1", "h2"], ["v1", "v2"]]);
  });
});

describe("field helpers", () => {
  test("secDateToIso accepts DD-MON-YYYY only", () => {
    expect(secDateToIso("31-MAR-2015")).toBe("2015-03-31");
    expect(secDateToIso("1-jan-2020")).toBe("2020-01-01");
    expect(secDateToIso("31-FEB-2015")).toBeNull();
    expect(secDateToIso("2015-03-31")).toBeNull();
    expect(secDateToIso("")).toBeNull();
  });
  test("known_at is 17:30 ET of the filing date (EDT and EST)", () => {
    expect(new Date(knownAtMsFor("2015-03-31")).toISOString()).toBe("2015-03-31T21:30:00.000Z");
    expect(new Date(knownAtMsFor("2015-01-15")).toISOString()).toBe("2015-01-15T22:30:00.000Z");
  });
  test("roles", () => {
    expect(parseRoles("Director,Officer")).toEqual(["director", "officer"]);
    expect(parseRoles("TenPercentOwner")).toEqual(["tenPercentOwner"]);
    expect(parseRoles("Other")).toEqual(["other"]);
    expect(parseRoles("")).toEqual([]);
  });
  test("tickers: junk dropped, class separators mapped to the index convention, mapping is point-in-time", () => {
    expect(tickerTokens("NONE")).toEqual([]);
    expect(tickerTokens("n/a")).toEqual([]);
    expect(tickerTokens("BRK-A, BRK-B")).toEqual(["BRK-A", "BRK-B"]);
    expect(dotForm("BRK-B")).toBe("BRK.B");
    expect(resolveSymbol("BRK-B", "2015-03-31", isMember)).toEqual({ symbol: "BRK.B", mapped: true });
    expect(resolveSymbol("BRK-A, ACME", "2015-03-31", isMember)).toEqual({ symbol: "ACME", mapped: true });
    expect(resolveSymbol("ZZZ", "2015-03-31", isMember)).toEqual({ symbol: "ZZZ", mapped: false });
    expect(resolveSymbol("ACME", "2015-03-31", () => false)).toEqual({ symbol: "ACME", mapped: false }); // not a member THAT day
    expect(resolveSymbol("NONE", "2015-03-31", isMember)).toBeNull();
  });
});

describe("extraction on the fixture", () => {
  const { buys, counts } = extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS });

  test("only code P of Forms 4 and 4/A (not S, not A grants, not Form 5)", () => {
    expect(counts.form4Submissions).toBe(5);
    expect(counts.purchaseRows).toBe(5);
    expect(buys.map(b => b.accession).sort()).toEqual(["0000000001-15-000001", "0000000002-15-000002", "0000000003-15-000003", "0000000005-15-000005", "0000000006-15-000006"]);
  });

  test("rows: dollar weight, roles, actors, amendments deduplicated to the earliest public filing", () => {
    const { rows, stats } = buysToRows(buys, isMember);
    expect(stats.duplicatesDropped).toBe(1); // the 4/A of the first purchase
    expect(stats.noTicker).toBe(1); // issuer ticker NONE
    expect(rows.length).toBe(3);
    const byAcc = new Map(rows.map(r => [JSON.parse(r.meta_json).accession as string, r]));

    const joint = byAcc.get("0000000001-15-000001")!;
    const jm = JSON.parse(joint.meta_json);
    expect(joint.source).toBe(SEC_FORM4_BUY_SOURCE);
    expect(joint.symbol).toBe("ACME");
    expect(joint.weight).toBe(10_000);
    expect(jm.role).toEqual(["director", "officer"]);
    // a joint filing is ONE actor (the primary owner: an officer/director first, ties by CIK); both owners stay listed
    expect(jm.actors).toEqual(["0000900001"]);
    expect(jm.owners.map((o: { cik: string }) => o.cik)).toEqual(["0000900001", "0000900002"]);
    expect(stats.jointFilings).toBe(1);
    expect(jm.shares).toBe(1000);
    expect(jm.price).toBe(10);
    expect(jm.lagDays).toBe(4);
    expect(jm.sp500).toBe(true);
    expect(new Date(joint.known_at_ms).toISOString()).toBe("2015-03-30T21:30:00.000Z");

    const berk = byAcc.get("0000000002-15-000002")!;
    expect(berk.symbol).toBe("BRK.B");
    expect(berk.weight).toBe(0); // no price: kept, with no dollar value
    expect(JSON.parse(berk.meta_json).price).toBeNull();
    expect(JSON.parse(berk.meta_json).role).toEqual(["tenPercentOwner"]);

    // same size/price/day as Alice's would collide only if the owner were ignored
    expect(byAcc.get("0000000006-15-000006")!.weight).toBe(10_000);
  });

  test("data typos: a year-0015 transaction date is not a date, an absurd dollar value keeps the row with no weight", () => {
    const trans = TRANS_HEADER + "\n"
      + "0000000001-15-000001\t1\tCommon Stock\t26-MAR-0015\tP\t1000000.0\t100000000.0\tA\n"
      + "0000000002-15-000002\t2\tCommon Stock\t20-MAR-1999\tP\t10.0\t5.0\tA\n";
    const { buys, counts } = extractBuys({ submission: SUBMISSION, owners: OWNERS, trans });
    expect(counts.badTxDate).toBe(1);
    const { rows, stats } = buysToRows(buys, isMember);
    expect(stats.implausibleDollars).toBe(1);
    const bad = rows.find(r => JSON.parse(r.meta_json).accession === "0000000001-15-000001")!;
    expect(bad.weight).toBe(0);
    expect(JSON.parse(bad.meta_json).suspectDollars).toBe(1e14);
    expect(JSON.parse(bad.meta_json).txDate).toBeNull();
    expect(JSON.parse(bad.meta_json).lagDays).toBeNull();
    // a genuinely years-late report stays, with its true lag
    expect(JSON.parse(rows.find(r => JSON.parse(r.meta_json).accession === "0000000002-15-000002")!.meta_json).lagDays).toBeGreaterThan(5000);
  });

  test("different owners never share a dedup key", () => {
    const [a, b] = [buys.find(x => x.accession === "0000000001-15-000001")!, buys.find(x => x.accession === "0000000006-15-000006")!];
    expect(buyKey({ ...a, txDate: "2015-04-01" })).not.toBe(buyKey(b));
  });

  test("dedup carries across quarters through the shared `seen` map", () => {
    const ctx = newBuildContext();
    const first = buysToRows(buys.filter(b => b.form === "4"), isMember, ctx);
    const later = buysToRows(buys.filter(b => b.form === "4/A"), isMember, ctx);
    expect(first.rows.length).toBe(3);
    expect(later.rows.length).toBe(0);
    expect(later.stats.duplicatesDropped).toBe(1);
  });
});

describe("zip reader", () => {
  const crc = (b: Uint8Array) => Number(Bun.hash.crc32(b)) >>> 0;
  function makeZip(files: Record<string, string>, store = false): Uint8Array {
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const enc = new TextEncoder();
    for (const [name, text] of Object.entries(files)) {
      const data = enc.encode(text), nameB = enc.encode(name);
      const body = store ? data : deflateRawSync(data);
      const local = new Uint8Array(30 + nameB.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, store ? 0 : 8, true);
      dv.setUint32(14, crc(data), true); dv.setUint32(18, body.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameB.length, true);
      local.set(nameB, 30);
      const cen = new Uint8Array(46 + nameB.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, store ? 0 : 8, true);
      cv.setUint32(16, crc(data), true); cv.setUint32(20, body.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
      cen.set(nameB, 46);
      parts.push(local, body);
      central.push(cen);
      offset += local.length + body.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const all = [...parts, ...central, eocd];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  test("reads deflated and stored entries; a truncated file is rejected", () => {
    const files = { "SUBMISSION.tsv": SUBMISSION, "REPORTINGOWNER.tsv": OWNERS, "NONDERIV_TRANS.tsv": TRANS };
    for (const store of [false, true]) {
      const zip = makeZip(files, store);
      const entries = listZip(zip);
      expect([...entries.keys()].sort()).toEqual(["NONDERIV_TRANS.tsv", "REPORTINGOWNER.tsv", "SUBMISSION.tsv"]);
      expect(readZipText(zip, "SUBMISSION.tsv", entries)).toBe(SUBMISSION);
      const { buys } = extractBuys({ submission: readZipText(zip, "SUBMISSION.tsv"), owners: readZipText(zip, "REPORTINGOWNER.tsv"), trans: readZipText(zip, "NONDERIV_TRANS.tsv") });
      expect(buys.length).toBe(5);
    }
    const zip = makeZip({ "a.tsv": "x" });
    expect(() => listZip(zip.subarray(0, zip.length - 10))).toThrow(/truncated|central/);
    expect(() => readZipText(zip, "missing.tsv")).toThrow(/not found/);
  });
});

describe("signals.db", () => {
  const rowsFor = () => buysToRows(extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS }).buys, isMember).rows;

  test("the table keeps exactly the shared format", () => {
    const db = new Database(":memory:");
    db.exec(SIGNAL_EVENTS_DDL);
    const cols = db.query("PRAGMA table_info(signal_events)").all() as Array<{ name: string; type: string }>;
    expect(cols.map(c => `${c.name}:${c.type}`)).toEqual(["source:TEXT", "symbol:TEXT", "known_at_ms:INTEGER", "weight:REAL", "meta_json:TEXT"]);
  });

  test("rebuilds are idempotent and never touch another producer's rows", () => {
    const path = join(dir, "signals.db");
    const db = openSignalsDbForWrite(path);
    db.prepare("INSERT INTO signal_events VALUES ('hl-whale', 'BTC', 1, 5, '{}')").run();
    expect(replaceSourceRows(db, SEC_FORM4_BUY_SOURCE, rowsFor())).toBe(3);
    expect(replaceSourceRows(db, SEC_FORM4_BUY_SOURCE, rowsFor())).toBe(3);
    expect((db.query("SELECT count(*) n FROM signal_events WHERE source = ?").get(SEC_FORM4_BUY_SOURCE) as { n: number }).n).toBe(3);
    expect((db.query("SELECT count(*) n FROM signal_events WHERE source = 'hl-whale'").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("hash is independent of insertion order and changes with the data", () => {
    const rows = rowsFor();
    const mk = (name: string, list: SignalRow[]) => { const p = join(dir, name); const d = openSignalsDbForWrite(p); replaceSourceRows(d, SEC_FORM4_BUY_SOURCE, list); d.close(); return p; };
    const toMs = Date.parse("2016-01-01");
    const a = hashSignalEvents(mk("h-a.db", rows), [SEC_FORM4_BUY_SOURCE], toMs);
    const b = hashSignalEvents(mk("h-b.db", [...rows].reverse()), [SEC_FORM4_BUY_SOURCE], toMs);
    const c = hashSignalEvents(mk("h-c.db", rows.map((r, i) => (i === 0 ? { ...r, weight: r.weight + 1 } : r))), [SEC_FORM4_BUY_SOURCE], toMs);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(() => hashSignalEvents(join(dir, "h-a.db"), ["nope"], toMs)).toThrow(/no rows/);
  });

  test("SignalView: an event is invisible before its known_at and visible from the filing day's session on", () => {
    const path = join(dir, "view.db");
    const db = openSignalsDbForWrite(path);
    replaceSourceRows(db, SEC_FORM4_BUY_SOURCE, rowsFor());
    const events = loadSignalEvents(db, SEC_FORM4_BUY_SOURCE, 0, Date.parse("2016-01-01"));
    db.close();
    const book = new SignalBook(events, "us");
    const acme = (asOf: string, lookback = 30) => book.at(asOf).events(SEC_FORM4_BUY_SOURCE, lookback).filter(e => e.symbol === "ACME").length;
    // ACME events: filed 30-MAR (known 21:30Z) and 03-APR (Friday)
    expect(acme("2015-03-27")).toBe(0);
    expect(acme("2015-03-30")).toBe(1);
    expect(acme("2015-04-02")).toBe(1);
    expect(acme("2015-04-03")).toBe(2);
    // calendar window: 3 days up to and including 2015-04-03 = Apr 1..3 → only the second
    expect(acme("2015-04-03", 3)).toBe(1);
    expect(acme("2015-04-03", 4)).toBe(1); // Mar 31..Apr 3: the Mar 30 filing is just outside
    expect(acme("2015-04-03", 5)).toBe(2);
    expect(book.at("2015-04-03").events("other-source", 30)).toEqual([]);
    // the view exposes its own cutoff: the end of the asOf day (ET)
    expect(new Date(book.at("2015-03-30").cutoffMs).toISOString()).toBe("2015-03-31T03:59:59.999Z");
  });
});

describe("descriptive statistics", () => {
  test("events per year, S&P mapping share and the filing-lag distribution (counts only)", () => {
    const rows = buysToRows(extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS }).buys, isMember).rows;
    const s = summarizeRows(rows);
    expect(s.rows).toBe(3);
    expect(s.byYear["2015"].events).toBe(3);
    expect(s.byYear["2015"].sp500Events).toBe(3);
    expect(s.byYear["2015"].sp500Share).toBe(1);
    expect(s.byYear["2015"].symbols).toBe(2);
    expect(s.byYear["2015"].pricedEvents).toBe(2);
    expect(s.total.officerOrDirectorEvents).toBe(2);
    expect(s.total.tenPercentOnlyEvents).toBe(1);
    expect(s.lagDays.n).toBe(3);
    expect(s.lagDays.p50).toBe(4); // lags 4, 4, 2 days → sorted 2,4,4
    expect(s.lagDays.max).toBe(4);
    expect(s.lagDays.share0to2).toBeCloseTo(1 / 3, 6);
    expect(s.quarters["2015q1"]).toBe(2);
    expect(s.quarters["2015q2"]).toBe(1);
    expect(JSON.stringify(s)).not.toMatch(/return|pnl/i);
  });
});

// ── opportunistic vs routine, 10b5-1, related owners (design A) ────────────

const ym = (y: number, m: number) => y * 12 + m - 1;

describe("opportunistic vs routine (Cohen-Malloy-Pomorski), point in time", () => {
  const hist = (entries: Array<[string, number, number, string]>): TradeHistory => new Map(entries.map(([cik, y, m, filed]) => [`${cik}|${ym(y, m)}`, filed]));
  // event: tx 2023-03-14, filed 2023-03-16
  const classify = (h: TradeHistory, first = 2012, tx: string | null = "2023-03-14", filed = "2023-03-16") => classifyInsider(h, "c1", tx, filed, first);

  test("routine = the same calendar month in each of the three previous years, all known before the event", () => {
    const full = hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 3, "2020-03-31"]]);
    expect(classify(full)).toBe("routine");
    // another month, another owner, or a missing year: opportunistic
    expect(classify(hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 4, "2020-04-30"]]))).toBe("opportunistic");
    expect(classify(hist([["c2", 2022, 3, "2022-03-20"], ["c2", 2021, 3, "2021-04-02"], ["c2", 2020, 3, "2020-03-31"]]))).toBe("opportunistic");
    expect(classify(hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"]]))).toBe("opportunistic");
    expect(classify(new Map())).toBe("opportunistic");
  });

  test("only filings known BEFORE the event count (a late report of last year's trade does not)", () => {
    expect(classify(hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 3, "2023-03-20"]]))).toBe("opportunistic"); // filed after the event
    expect(classify(hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 3, "2023-03-16"]]))).toBe("opportunistic"); // same day is not before
    expect(classify(hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 3, "2023-03-15"]]))).toBe("routine");
  });

  test("unknown when the history does not cover the three previous calendar years, or the event has no date", () => {
    const full = hist([["c1", 2022, 3, "2022-03-20"], ["c1", 2021, 3, "2021-04-02"], ["c1", 2020, 3, "2020-03-31"]]);
    expect(classify(full, 2021)).toBe("unknown"); // 2023 − 3 = 2020 < 2021
    expect(classify(full, 2020)).toBe("routine");
    expect(classify(full, 2012, null)).toBe("unknown");
    expect(classifyInsider(full, "", "2023-03-14", "2023-03-16", 2012)).toBe("unknown");
  });

  test("the history comes from open-market P AND S trades of every owner of Forms 4/4A (not Form 5, not other codes)", () => {
    const { history } = extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS });
    // acc1: purchase 26-MAR-2015 and sale 26-MAR-2015 by Alice and Bob, filed 30-MAR-2015; the A grant does not count
    expect(history.get(`0000900001|${ym(2015, 3)}`)).toBe("2015-03-30");
    expect(history.get(`0000900002|${ym(2015, 3)}`)).toBe("2015-03-30");
    // the earliest filing of the month wins (the 4/A of the same trade was filed later)
    expect(history.get(`0000900003|${ym(2015, 3)}`)).toBe("2015-03-31");
    // Form 5 (Dan) never feeds it
    expect([...history.keys()].some(k => k.startsWith("0000900004|"))).toBe(false);
  });

  test("rows carry the class of the primary owner; the stats split the classes", () => {
    const { buys, history } = extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS });
    // Alice traded in March 2012-2014 as well, filed in time → routine for her March-2015 purchase
    for (const y of [2012, 2013, 2014]) history.set(`0000900001|${ym(y, 3)}`, `${y}-03-25`);
    const { rows, stats } = buysToRows(buys, isMember, newBuildContext({ history, firstFullYear: 2012 }));
    const cls = Object.fromEntries(rows.map(r => [JSON.parse(r.meta_json).accession, JSON.parse(r.meta_json).insiderClass]));
    expect(cls["0000000001-15-000001"]).toBe("routine");
    expect(cls["0000000002-15-000002"]).toBe("opportunistic");
    expect(stats.classes).toEqual({ opportunistic: 2, routine: 1, unknown: 0 });
    const s = summarizeRows(rows);
    expect(s.total.classAll).toEqual({ opportunistic: 2, routine: 1, unknown: 0 });
    expect(s.total.classSp500OfficerDirector.routine).toBe(1);
    // without a history every event is unknown (no claim)
    expect(buysToRows(buys, isMember).stats.classes.unknown).toBe(3);
  });

  test("emitFrom: earlier filings feed the dedup state but are not emitted", () => {
    const { buys } = extractBuys({ submission: SUBMISSION, owners: OWNERS, trans: TRANS });
    const { rows, stats } = buysToRows(buys, isMember, newBuildContext({ emitFrom: "2015-03-31" }));
    expect(rows.map(r => JSON.parse(r.meta_json).accession).sort()).toEqual(["0000000002-15-000002", "0000000006-15-000006"]);
    expect(stats.beforeEmitFrom).toBe(1);
    expect(stats.duplicatesDropped).toBe(1); // the 4/A is still recognised as a duplicate of the earlier, not-emitted filing
  });
});

describe("Rule 10b5-1 plan flag", () => {
  test("text and checkbox parsing", () => {
    expect(parseCheckbox("1")).toBe(true);
    expect(parseCheckbox("true")).toBe(true);
    expect(parseCheckbox("0")).toBe(false);
    expect(parseCheckbox("false")).toBe(false);
    expect(parseCheckbox("")).toBeNull();
    expect(parseCheckbox(undefined)).toBeNull();
    expect(mentionsPlan10b5("Purchase made pursuant to a Rule 10b5-1 trading plan adopted on 1/2/2023")).toBe(true);
    expect(mentionsPlan10b5("effected under a 10b5-1 plan")).toBe(true);
    expect(mentionsPlan10b5("This purchase was not made pursuant to a Rule 10b5-1 plan.")).toBe(false);
    expect(mentionsPlan10b5("Open market purchase")).toBe(false);
  });

  const SUB = [
    "ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tREMARKS\tAFF10B5ONE",
    "A-1\t30-APR-2024\t4\t0000111111\tAcme\tACME\t\t1",
    "B-2\t30-APR-2024\t4\t0000111111\tAcme\tACME\t\t0",
    "C-3\t30-APR-2024\t4\t0000111111\tAcme\tACME\tTrades under Rule 10b5-1 plan\t",
    "D-4\t30-APR-2024\t4\t0000111111\tAcme\tACME\t\t0",
    "E-5\t30-APR-2024\t4\t0000111111\tAcme\tACME\t\t",
  ].join("\n") + "\n";
  const OWN = ["ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE",
    ...["A-1", "B-2", "C-3", "D-4", "E-5"].map((a, i) => `${a}\t000090000${i}\tOwner ${i}\tDirector\t`)].join("\n") + "\n";
  const TR = [
    "ACCESSION_NUMBER\tSECURITY_TITLE\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_SHARES_FN\tTRANS_PRICEPERSHARE\tTRANS_DATE_FN",
    "A-1\tCommon\t29-APR-2024\tP\t100\t\t10\t",
    "B-2\tCommon\t29-APR-2024\tP\t200\tF1\t10\t",
    "C-3\tCommon\t29-APR-2024\tP\t300\t\t10\t",
    "D-4\tCommon\t29-APR-2024\tP\t400\t\t10\tF1",
    "E-5\tCommon\t29-APR-2024\tP\t500\tF2\t10\t",
  ].join("\n") + "\n";
  const FN = [
    "ACCESSION_NUMBER\tFOOTNOTE_ID\tFOOTNOTE_TXT",
    "B-2\tF1\tThe purchase was made pursuant to a Rule 10b5-1 trading plan.",
    "D-4\tF1\tNot pursuant to a Rule 10b5-1 trading plan.",
    "E-5\tF2\tIncludes shares held by spouse.",
    "E-5\tF1\tA 10b5-1 plan note on a footnote the row does not reference.",
  ].join("\n") + "\n";

  test("the checkbox, a footnote attached to the row, or the remarks; a negation or an unreferenced footnote is not a plan", () => {
    const { buys } = extractBuys({ submission: SUB, owners: OWN, trans: TR, footnotes: FN });
    const { rows } = buysToRows(buys, isMember);
    const meta = Object.fromEntries(rows.map(r => [JSON.parse(r.meta_json).accession, JSON.parse(r.meta_json)]));
    expect([meta["A-1"].plan10b5_1, meta["A-1"].plan10b5_1Source]).toEqual([true, "checkbox"]);
    expect([meta["B-2"].plan10b5_1, meta["B-2"].plan10b5_1Source]).toEqual([true, "footnote"]);
    expect([meta["C-3"].plan10b5_1, meta["C-3"].plan10b5_1Source]).toEqual([true, "remarks"]);
    expect([meta["D-4"].plan10b5_1, meta["D-4"].plan10b5_1Source]).toEqual([false, null]);
    expect([meta["E-5"].plan10b5_1, meta["E-5"].plan10b5_1Source]).toEqual([false, null]);
    // whether the checkbox existed for the filing at all
    expect([meta["A-1"].plan10b5_1Field, meta["B-2"].plan10b5_1Field, meta["C-3"].plan10b5_1Field, meta["E-5"].plan10b5_1Field]).toEqual([true, true, false, false]);
    // without the footnotes table only the checkbox and the remarks speak
    const noFn = buysToRows(extractBuys({ submission: SUB, owners: OWN, trans: TR }).buys, isMember).rows.map(r => JSON.parse(r.meta_json));
    expect(noFn.find(m => m.accession === "B-2").plan10b5_1).toBe(false);
  });

  test("coverage by year in the stats", () => {
    const { buys } = extractBuys({ submission: SUB, owners: OWN, trans: TR, footnotes: FN });
    const s = summarizeRows(buysToRows(buys, isMember).rows);
    expect(s.byYear["2024"].plan).toEqual({ fieldPresent: 3, flaggedCheckbox: 1, flaggedFootnote: 1, flaggedRemarks: 1, flaggedAny: 3, fieldPresentFlaggedShare: 1 / 3 });
  });
});

describe("the same transaction reported by related owners", () => {
  // acc7: the 10%-owner fund files its OWN Form 4 for the very purchase Alice and Bob reported in acc1
  const sub = SUBMISSION + "0000000007-15-000007\t31-MAR-2015\t27-MAR-2015\t4\t0000111111\tAcme Corp\tACME\t\n";
  const own = OWNERS + "0000000007-15-000007\t0000900007\tAcme Fund LP\tTenPercentOwner\t\n";
  const trans = TRANS + "0000000007-15-000007\t9\tCommon Stock\t26-MAR-2015\tP\t1000.0\t10.00\tA\n";

  test("transactionKey ignores the owners but needs a date, shares and a price", () => {
    const { buys } = extractBuys({ submission: sub, owners: own, trans });
    const a = buys.find(b => b.accession === "0000000001-15-000001")!, f = buys.find(b => b.accession === "0000000007-15-000007")!;
    expect(transactionKey(a)).toBe(transactionKey(f));
    expect(buyKey(a)).not.toBe(buyKey(f));
    expect(transactionKey({ ...a, price: null })).toBeNull();
    expect(transactionKey({ ...a, txDate: null })).toBeNull();
  });

  test("the later filing is dropped, the earlier event is untouched, and the merge is counted (by year, S&P-mapped)", () => {
    const { buys } = extractBuys({ submission: sub, owners: own, trans });
    const { rows, stats } = buysToRows(buys, isMember);
    expect(rows.length).toBe(3); // dollars and insiders of that trade are not doubled
    expect(stats.mergedRelated).toBe(1);
    expect(stats.mergedRelatedSp500).toBe(1);
    expect(stats.mergedRelatedByYear).toEqual({ "2015": 1 });
    const acme = JSON.parse(rows.find(r => JSON.parse(r.meta_json).accession === "0000000001-15-000001")!.meta_json);
    expect(acme.actors).toEqual(["0000900001"]); // nothing of the later filing leaks into the earlier event
    expect(rows.some(r => JSON.parse(r.meta_json).accession === "0000000007-15-000007")).toBe(false);
  });

  test("a different date, size or price is a different trade", () => {
    const other = TRANS + "0000000007-15-000007\t9\tCommon Stock\t26-MAR-2015\tP\t1000.0\t10.01\tA\n"; // one cent off
    const { buys } = extractBuys({ submission: sub, owners: own, trans: other });
    expect(buysToRows(buys, isMember).stats.mergedRelated).toBe(0);
  });

  test("the primary owner of a joint filing is an officer/director before a fund, ties by CIK", () => {
    const o = (cik: string, roles: Array<"officer" | "director" | "tenPercentOwner" | "other">) => ({ cik, name: cik, roles, title: "" });
    expect(primaryOwner([o("9", ["tenPercentOwner"]), o("5", ["director"])]).cik).toBe("5");
    expect(primaryOwner([o("9", ["officer"]), o("5", ["director"])]).cik).toBe("5");
    expect(primaryOwner([o("9", ["other"]), o("5", ["tenPercentOwner"])]).cik).toBe("5");
  });
});
