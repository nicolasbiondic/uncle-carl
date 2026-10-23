// ══════════════════════════════════════════════════════════════════════
// SEC "Insider Transactions Data Sets" (Forms 3/4/5, quarterly zips) →
// signal_events rows of source "sec-form4-buy" (one per open-market purchase,
// transaction code P). Pure parsing: no network, no database here (the CLIs
// scripts/sec-insider-fetch.ts and scripts/sec-insider-build.ts do the I/O).
//
// What the data sets give us (verified on 2015q1, readme in every zip):
//   SUBMISSION.tsv      one row per filing: FILING_DATE (DD-MON-YYYY, a DATE —
//                       no acceptance time), DOCUMENT_TYPE (3, 3/A, 4, 4/A, 5, 5/A),
//                       ISSUERCIK, ISSUERNAME, ISSUERTRADINGSYMBOL
//   REPORTINGOWNER.tsv  one row per (filing, owner): RPTOWNERCIK, RPTOWNERNAME,
//                       RPTOWNER_RELATIONSHIP ("Director,Officer,TenPercentOwner,Other"), RPTOWNER_TITLE
//   NONDERIV_TRANS.tsv  one row per non-derivative transaction: TRANS_CODE, TRANS_DATE,
//                       TRANS_SHARES, TRANS_PRICEPERSHARE, SECURITY_TITLE
//
// known_at: the data sets carry only the filing DATE, never the EDGAR
// acceptance time, so the event is treated as known AFTER that day's close:
// 17:30 America/New_York of FILING_DATE. 17:30 is the EDGAR same-day cut-off
// (a Form 4 accepted later is dated the next business day), so no filing dated
// D can have been accepted after 17:30 on D: the stamp is never earlier than
// the real acceptance, and it is after the 16:00 close. A filing accepted the
// evening before and dated the next business day is therefore used one session
// late: conservative, never look-ahead.
// ══════════════════════════════════════════════════════════════════════

import { inflateRawSync } from "node:zlib";
import { getETDayBounds } from "../../src/db/database";
import type { SignalRow } from "./signalData";

export const SEC_FORM4_BUY_SOURCE = "sec-form4-buy";
/** Minutes after ET midnight at which a filing date is treated as public (17:30 ET). */
export const KNOWN_AT_ET_MINUTES = 17 * 60 + 30;

// ── zip (store/deflate, no zip64: the data-set zips are < 100 MB) ─────────

export interface ZipEntryInfo { name: string; method: number; compressedSize: number; size: number; localOffset: number }

function view(buf: Uint8Array): DataView { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }

/** Central directory of a zip; throws on a truncated/corrupt archive (what a half-downloaded file looks like). */
export function listZip(buf: Uint8Array): Map<string, ZipEntryInfo> {
  const dv = view(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found (truncated file?)");
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip: zip64 is not supported");
  if (cdOffset + cdSize > buf.length) throw new Error("zip: central directory out of bounds (truncated file?)");
  const out = new Map<string, ZipEntryInfo>();
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < total; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readZipEntry(buf: Uint8Array, entry: ZipEntryInfo): Uint8Array {
  const dv = view(buf);
  if (dv.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${entry.name}`);
  const nameLen = dv.getUint16(entry.localOffset + 26, true), extraLen = dv.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

/** A named file of the archive as text (UTF-8, BOM stripped); throws when absent. */
export function readZipText(buf: Uint8Array, name: string, entries = listZip(buf)): string {
  const e = entries.get(name);
  if (!e) throw new Error(`zip: ${name} not found (has: ${[...entries.keys()].join(", ")})`);
  const text = new TextDecoder("utf-8").decode(readZipEntry(buf, e));
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ── TSV with CSV-style quoting (REMARKS fields carry quotes/newlines) ─────

/** Rows of fields. A field starting with `"` is quoted (`""` = quote, may hold tabs/newlines); blank lines are skipped. */
export function* tsvRows(text: string): Generator<string[]> {
  const n = text.length;
  let i = 0;
  let row: string[] = [];
  const isBlank = (r: string[]) => r.length === 1 && r[0] === "";
  while (i < n) {
    let field = "";
    if (text.charCodeAt(i) === 34) {
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { field += text.slice(j); i = n; break; }
        field += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) { field += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      // Junk between the closing quote and the delimiter is kept verbatim.
      while (i < n && text.charCodeAt(i) !== 9 && text.charCodeAt(i) !== 10) field += text[i++];
    } else {
      const t = text.indexOf("\t", i), nl = text.indexOf("\n", i);
      const end = Math.min(t < 0 ? n : t, nl < 0 ? n : nl);
      field = text.slice(i, end);
      i = end;
    }
    if ((i >= n || text.charCodeAt(i) === 10) && field.endsWith("\r")) field = field.slice(0, -1);
    row.push(field);
    if (i >= n) break;
    const delimiter = text.charCodeAt(i++);
    if (delimiter === 10) {
      if (!isBlank(row)) yield row;
      row = [];
    }
  }
  if (row.length > 0 && !isBlank(row)) yield row;
}

export interface Table { header: string[]; rows: Iterable<string[]>; col(name: string): number }

export function readTable(text: string): Table {
  const it = tsvRows(text);
  const first = it.next();
  if (first.done) throw new Error("tsv: empty file");
  const header = first.value.map(h => h.trim());
  const index = new Map(header.map((h, i) => [h, i]));
  return {
    header,
    rows: { [Symbol.iterator]: () => it },
    col(name: string) {
      const i = index.get(name);
      if (i === undefined) throw new Error(`tsv: column ${name} missing (has: ${header.join(", ")})`);
      return i;
    },
  };
}

// ── fields ────────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "31-MAR-2015" → "2015-03-31"; null when it is not a valid date. */
export function secDateToIso(s: string | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s ?? "").trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toUpperCase()];
  if (!mm) return null;
  const iso = `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** ms at which an ISO filing date is treated as public: 17:30 ET of that date (see the header). */
export function knownAtMsFor(filingDateIso: string): number {
  return getETDayBounds(filingDateIso)[0] + KNOWN_AT_ET_MINUTES * 60_000;
}

export type InsiderRole = "officer" | "director" | "tenPercentOwner" | "other";

/** "Director,Officer" / "TenPercentOwner" … → canonical roles (sorted, unique). */
export function parseRoles(relationship: string | undefined): InsiderRole[] {
  const s = (relationship ?? "").toLowerCase();
  const roles: InsiderRole[] = [];
  if (s.includes("director")) roles.push("director");
  if (s.includes("officer")) roles.push("officer");
  if (s.includes("tenpercent") || s.includes("10%")) roles.push("tenPercentOwner");
  if (s.includes("other")) roles.push("other");
  return roles.sort();
}

const NO_TICKER = new Set(["", "NONE", "N/A", "NA", "NULL", "NIL", "-", "--", "N.A.", "NOT APPLICABLE", "NO TICKER"]);

/** Cleaned ticker tokens of an ISSUERTRADINGSYMBOL ("BRK-A, BRK-B" → two tokens); [] when it carries none. */
export function tickerTokens(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const tok of (raw ?? "").toUpperCase().split(/[,;\s]+/)) {
    const t = tok.replace(/^\$+/, "").trim();
    if (NO_TICKER.has(t) || !/^[A-Z0-9][A-Z0-9.\-/_]{0,9}$/.test(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

/** Class-share separators (BRK-B, BRK/B, BRK_B) → the hist-sp500 convention "BRK.B". */
export function dotForm(t: string): string { return t.replace(/[-/_]/g, "."); }

/**
 * The symbol of an event, mapped point-in-time to the index tickers: the first
 * token/variant that is a member on the filing date; otherwise the first token
 * in dotted form with mapped=false. null when the issuer has no usable ticker.
 */
export function resolveSymbol(raw: string | undefined, dateIso: string, isMember: (symbol: string, dateIso: string) => boolean): { symbol: string; mapped: boolean } | null {
  const tokens = tickerTokens(raw);
  if (tokens.length === 0) return null;
  for (const t of tokens) {
    for (const v of new Set([t, dotForm(t)])) if (isMember(v, dateIso)) return { symbol: v, mapped: true };
  }
  return { symbol: dotForm(tokens[0]), mapped: false };
}

// ── extraction ────────────────────────────────────────────────────────────

export interface SecOwner { cik: string; name: string; roles: InsiderRole[]; title: string }

/** Where a Rule 10b5-1 plan shows up in the data sets: the AFF10B5ONE checkbox of SUBMISSION (Form 4s from
 *  2023-04 on; the zips carry the column for every quarter but it is empty before), or the text of a footnote
 *  attached to the transaction row, or the filing's REMARKS (the only trace before the checkbox existed). */
export interface PlanFlags { checkbox: boolean | null; footnote: boolean; remarks: boolean }

export interface SecBuy {
  accession: string;
  form: "4" | "4/A";
  filingDate: string;
  txDate: string | null;
  issuerCik: string;
  issuerName: string;
  rawTicker: string;
  security: string;
  shares: number | null;
  price: number | null;
  owners: SecOwner[];
  plan: PlanFlags;
}

/** `${ownerCik}|${year*12 + month-1}` → the earliest FILING_DATE (ISO) of a filing that reported an open-market
 *  trade (code P or S) by that owner in that calendar month. The classification history, point-in-time by filing date. */
export type TradeHistory = Map<string, string>;

export interface ExtractCounts {
  submissions: number;
  form4Submissions: number;
  purchaseRows: number;
  tradeRows: number;
  badFilingDate: number;
  badTxDate: number;
  noOwner: number;
}

/** Transaction dates before this are typos (EDGAR electronic filing starts in the 1990s). */
const MIN_PLAUSIBLE_TX_DATE = "1990-01-01";
/** A single purchase above this is a price/share typo, not a trade (the whole US equity market is ~$5e13). */
export const MAX_PLAUSIBLE_DOLLARS = 5e10;

const num = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** "1"/"true" → true, "0"/"false" → false, anything else (blank, absent column) → null. */
export function parseCheckbox(s: string | undefined): boolean | null {
  const t = (s ?? "").trim().toLowerCase();
  return t === "1" || t === "true" ? true : t === "0" || t === "false" ? false : null;
}

const PLAN_RE = /10b5\s*-?\s*1/i;
const PLAN_NEGATED_RE = /\b(not|no|neither|nor|without|never)\b[^.;]{0,80}10b5\s*-?\s*1/i;

/** True when a free text says the transaction was made under a Rule 10b5-1 plan (a negation like "not pursuant to a 10b5-1 plan" does not count). */
export function mentionsPlan10b5(text: string | undefined): boolean {
  const t = text ?? "";
  return PLAN_RE.test(t) && !PLAN_NEGATED_RE.test(t);
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/**
 * The open-market purchases (TRANS_CODE P) of Forms 4 and 4/A in one quarter's tables, plus (into `history`) every
 * open-market trade (P or S) of every reporting owner — the material the opportunistic/routine classification needs.
 * `footnotes` (FOOTNOTES.tsv) is optional: without it the plan flag only knows the checkbox and REMARKS.
 */
export function extractBuys(
  tables: { submission: string; owners: string; trans: string; footnotes?: string },
  history: TradeHistory = new Map(),
): { buys: SecBuy[]; counts: ExtractCounts; history: TradeHistory } {
  const counts: ExtractCounts = { submissions: 0, form4Submissions: 0, purchaseRows: 0, tradeRows: 0, badFilingDate: 0, badTxDate: 0, noOwner: 0 };

  const sub = readTable(tables.submission);
  const sAcc = sub.col("ACCESSION_NUMBER"), sDate = sub.col("FILING_DATE"), sType = sub.col("DOCUMENT_TYPE");
  const sCik = sub.col("ISSUERCIK"), sName = sub.col("ISSUERNAME"), sTicker = sub.col("ISSUERTRADINGSYMBOL");
  const sRemarks = sub.header.includes("REMARKS") ? sub.col("REMARKS") : -1;
  const sPlan = sub.header.includes("AFF10B5ONE") ? sub.col("AFF10B5ONE") : -1;
  const submissions = new Map<string, { form: "4" | "4/A"; filingDate: string; issuerCik: string; issuerName: string; rawTicker: string; plan: Pick<PlanFlags, "checkbox" | "remarks"> }>();
  for (const r of sub.rows) {
    counts.submissions++;
    const type = (r[sType] ?? "").trim();
    if (type !== "4" && type !== "4/A") continue;
    counts.form4Submissions++;
    const filingDate = secDateToIso(r[sDate]);
    if (!filingDate) { counts.badFilingDate++; continue; }
    submissions.set(r[sAcc].trim(), {
      form: type, filingDate, issuerCik: (r[sCik] ?? "").trim(), issuerName: (r[sName] ?? "").trim(), rawTicker: (r[sTicker] ?? "").trim(),
      plan: { checkbox: sPlan >= 0 ? parseCheckbox(r[sPlan]) : null, remarks: sRemarks >= 0 && mentionsPlan10b5(r[sRemarks]) },
    });
  }

  const tr = readTable(tables.trans);
  const tAcc = tr.col("ACCESSION_NUMBER"), tCode = tr.col("TRANS_CODE"), tDate = tr.col("TRANS_DATE"), tSec = tr.col("SECURITY_TITLE");
  const tShares = tr.col("TRANS_SHARES"), tPrice = tr.col("TRANS_PRICEPERSHARE");
  const fnCols = tr.header.map((h, i) => (h.endsWith("_FN") ? i : -1)).filter(i => i >= 0);
  const purchases: Array<{ acc: string; txDate: string | null; security: string; shares: number | null; price: number | null; fnIds: string[] }> = [];
  const trades: Array<{ acc: string; ym: number }> = [];
  const wanted = new Set<string>();
  for (const r of tr.rows) {
    const code = (r[tCode] ?? "").trim();
    if (code !== "P" && code !== "S") continue;
    const acc = r[tAcc].trim();
    if (!submissions.has(acc)) continue;
    let txDate = secDateToIso(r[tDate]);
    // Typos like year 0015 / 1900: not a date (a genuine years-late report still stays, e.g. 1999).
    if (txDate !== null && txDate < MIN_PLAUSIBLE_TX_DATE) { counts.badTxDate++; txDate = null; }
    counts.tradeRows++;
    wanted.add(acc);
    if (txDate !== null) trades.push({ acc, ym: monthIndex(txDate) });
    if (code !== "P") continue;
    counts.purchaseRows++;
    const fnIds = fnCols.flatMap(i => (r[i] ?? "").split(/[\s,;]+/).filter(Boolean));
    purchases.push({ acc, txDate, security: (r[tSec] ?? "").trim(), shares: num(r[tShares]), price: num(r[tPrice]), fnIds });
  }

  const ow = readTable(tables.owners);
  const oAcc = ow.col("ACCESSION_NUMBER"), oCik = ow.col("RPTOWNERCIK"), oName = ow.col("RPTOWNERNAME");
  const oRel = ow.col("RPTOWNER_RELATIONSHIP"), oTitle = ow.col("RPTOWNER_TITLE");
  const owners = new Map<string, SecOwner[]>();
  for (const r of ow.rows) {
    const acc = r[oAcc].trim();
    if (!wanted.has(acc)) continue;
    const list = owners.get(acc) ?? owners.set(acc, []).get(acc)!;
    list.push({ cik: (r[oCik] ?? "").trim(), name: (r[oName] ?? "").trim(), roles: parseRoles(r[oRel]), title: (r[oTitle] ?? "").trim() });
  }

  // History: every owner of the filing traded in that month; keep the earliest filing date.
  for (const t of trades) {
    const filingDate = submissions.get(t.acc)!.filingDate;
    for (const o of owners.get(t.acc) ?? []) {
      if (!o.cik) continue;
      const key = `${o.cik}|${t.ym}`;
      const prev = history.get(key);
      if (prev === undefined || filingDate < prev) history.set(key, filingDate);
    }
  }

  // Footnotes that mention a 10b5-1 plan, only for the filings that hold a purchase.
  const planFootnotes = new Set<string>();
  if (tables.footnotes !== undefined && purchases.length > 0) {
    const buyAccs = new Set(purchases.map(p => p.acc));
    const fn = readTable(tables.footnotes);
    const fAcc = fn.col("ACCESSION_NUMBER"), fId = fn.col("FOOTNOTE_ID"), fTxt = fn.col("FOOTNOTE_TXT");
    for (const r of fn.rows) {
      const acc = (r[fAcc] ?? "").trim();
      if (buyAccs.has(acc) && mentionsPlan10b5(r[fTxt])) planFootnotes.add(`${acc}|${(r[fId] ?? "").trim()}`);
    }
  }

  const buys: SecBuy[] = [];
  for (const p of purchases) {
    const s = submissions.get(p.acc)!;
    const list = owners.get(p.acc);
    if (!list || list.length === 0) { counts.noOwner++; continue; }
    buys.push({
      accession: p.acc, form: s.form, filingDate: s.filingDate, txDate: p.txDate, issuerCik: s.issuerCik, issuerName: s.issuerName,
      rawTicker: s.rawTicker, security: p.security, shares: p.shares, price: p.price, owners: list,
      plan: { checkbox: s.plan.checkbox, remarks: s.plan.remarks, footnote: p.fnIds.some(id => planFootnotes.has(`${p.acc}|${id}`)) },
    });
  }
  return { buys, counts, history };
}

/** Key of one economic purchase by one owner set: an amendment (4/A) re-reports the same one. */
export function buyKey(b: SecBuy): string {
  const owners = [...new Set(b.owners.map(o => o.cik || o.name))].sort().join("+");
  return `${b.issuerCik}|${owners}|${b.txDate ?? ""}|${b.shares ?? ""}|${b.price ?? ""}|${b.security}`;
}

/** Key of one transaction REGARDLESS of who reports it (joint filers: a fund and its GP each file the same trade).
 *  null when it cannot identify one (no date, no shares or no price). */
export function transactionKey(b: SecBuy): string | null {
  if (!b.txDate || !(b.shares !== null && b.shares > 0) || !(b.price !== null && b.price > 0)) return null;
  return `${b.issuerCik}|${b.txDate}|${b.shares}|${b.price}|${b.security}`;
}

export type InsiderClass = "opportunistic" | "routine" | "unknown";

/**
 * Cohen, Malloy & Pomorski (2012), point in time: an owner is ROUTINE if they traded (open market, P or S) in the
 * same calendar month of the event in each of the three previous calendar years, counting only filings made BEFORE
 * the event's filing date; otherwise OPPORTUNISTIC. UNKNOWN when the history does not cover the three previous
 * calendar years completely (txDate − 3 years before `firstFullYear`) or the event has no usable date/owner.
 */
export function classifyInsider(history: TradeHistory, cik: string, txDate: string | null, filingDate: string, firstFullYear: number): InsiderClass {
  if (!txDate || !cik) return "unknown";
  const y = Number(txDate.slice(0, 4)), m = Number(txDate.slice(5, 7)) - 1;
  if (!(y - 3 >= firstFullYear)) return "unknown";
  for (let k = 1; k <= 3; k++) {
    const filed = history.get(`${cik}|${(y - k) * 12 + m}`);
    if (filed === undefined || !(filed < filingDate)) return "opportunistic";
  }
  return "routine";
}

/** The owner a (possibly joint) filing is credited to: an officer/director first, then a 10% owner, then the rest; ties by CIK. */
export function primaryOwner(owners: readonly SecOwner[]): SecOwner {
  const rank = (o: SecOwner) => (o.roles.includes("officer") || o.roles.includes("director") ? 0 : o.roles.includes("tenPercentOwner") ? 1 : 2);
  return [...owners].sort((a, b) => rank(a) - rank(b) || (a.cik < b.cik ? -1 : a.cik > b.cik ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

export interface BuildContext {
  /** buyKey → accession that first reported it (amendments of the same owners). */
  seen: Map<string, string>;
  /** transactionKey → accession that first reported it (the same trade reported by related owners). */
  seenTx: Map<string, string>;
  /** Trade history for the classification; absent = every event is "unknown". */
  history?: TradeHistory;
  /** First calendar year the history covers completely (e.g. 2012 when the first zip is 2012q1). */
  firstFullYear?: number;
  /** Only events whose filing date is >= this are emitted (earlier ones still register their dedup keys). */
  emitFrom?: string;
}

export const newBuildContext = (over: Partial<BuildContext> = {}): BuildContext => ({ seen: new Map(), seenTx: new Map(), ...over });

export interface BuildStats {
  eventsIn: number;
  /** Re-reports of the same purchase by the same owners (4/A) dropped. */
  duplicatesDropped: number;
  /** The same trade reported by related owners in ANOTHER filing, dropped (the earliest public one stays). */
  mergedRelated: number;
  /** …of which events whose issuer maps to a point-in-time index member (and per filing year). */
  mergedRelatedSp500: number;
  mergedRelatedByYear: Record<string, number>;
  /** Emitted events whose single filing lists more than one reporting owner (counted as ONE actor). */
  jointFilings: number;
  noTicker: number;
  implausibleDollars: number;
  beforeEmitFrom: number;
  classes: Record<InsiderClass, number>;
}

/**
 * Buys → signal rows. A purchase re-reported under ANOTHER accession by the same owners (4/A) keeps only the
 * earliest public one; the same transaction (issuer, date, shares, price) reported by DIFFERENT owners in another
 * filing is the same trade (a fund and its GP, spouses…): only the earliest public filing stays, nothing of the
 * later one leaks backwards. A single filing with several reporting owners is ONE event with ONE actor (the primary
 * owner), so neither dollars nor distinct-insider counts are doubled. Rows of one accession are never merged: two
 * fills of the same size on the same day in one filing are two purchases.
 * Feed it ALL buys oldest filing first (it sorts) with one shared context.
 */
export function buysToRows(buys: readonly SecBuy[], isMember: (symbol: string, dateIso: string) => boolean, ctx: BuildContext = newBuildContext()): { rows: SignalRow[]; stats: BuildStats } {
  const stats: BuildStats = { eventsIn: 0, duplicatesDropped: 0, mergedRelated: 0, mergedRelatedSp500: 0, mergedRelatedByYear: {}, jointFilings: 0, noTicker: 0, implausibleDollars: 0, beforeEmitFrom: 0, classes: { opportunistic: 0, routine: 0, unknown: 0 } };
  const ordered = [...buys].sort((a, b) => (a.filingDate < b.filingDate ? -1 : a.filingDate > b.filingDate ? 1
    : a.form !== b.form ? (a.form === "4" ? -1 : 1) : a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0));
  const rows: SignalRow[] = [];
  for (const b of ordered) {
    const inScope = ctx.emitFrom === undefined || b.filingDate >= ctx.emitFrom; // the counters describe the emitted period only
    if (inScope) stats.eventsIn++;
    const key = buyKey(b);
    const prev = ctx.seen.get(key);
    if (prev !== undefined && prev !== b.accession) { if (inScope) stats.duplicatesDropped++; continue; }
    const txKey = transactionKey(b);
    const prevTx = txKey ? ctx.seenTx.get(txKey) : undefined;
    const resolved = resolveSymbol(b.rawTicker, b.filingDate, isMember);
    if (prevTx !== undefined && prevTx !== b.accession) {
      if (inScope) {
        stats.mergedRelated++;
        if (resolved?.mapped) stats.mergedRelatedSp500++;
        const y = b.filingDate.slice(0, 4);
        stats.mergedRelatedByYear[y] = (stats.mergedRelatedByYear[y] ?? 0) + 1;
      }
      continue;
    }
    if (!resolved) { if (inScope) stats.noTicker++; continue; }
    ctx.seen.set(key, b.accession);
    if (txKey) ctx.seenTx.set(txKey, b.accession);
    if (!inScope) { stats.beforeEmitFrom++; continue; }
    const priced = b.shares !== null && b.price !== null && b.shares > 0 && b.price > 0;
    const rawDollars = priced ? b.shares! * b.price! : 0;
    // An implausible dollar value keeps the row (the purchase and its insider are real) with no dollar weight.
    const suspect = rawDollars > MAX_PLAUSIBLE_DOLLARS;
    if (suspect) stats.implausibleDollars++;
    const weight = suspect ? 0 : rawDollars;
    const roles = [...new Set(b.owners.flatMap(o => o.roles))].sort();
    const primary = primaryOwner(b.owners);
    const actor = primary.cik || primary.name;
    if (b.owners.length > 1) stats.jointFilings++;
    const insiderClass = ctx.history ? classifyInsider(ctx.history, primary.cik, b.txDate, b.filingDate, ctx.firstFullYear ?? Infinity) : "unknown";
    stats.classes[insiderClass]++;
    const lagDays = b.txDate ? Math.round((Date.parse(b.filingDate) - Date.parse(b.txDate)) / 86_400_000) : null;
    const planSource = b.plan.checkbox === true ? "checkbox" : b.plan.footnote ? "footnote" : b.plan.remarks ? "remarks" : null;
    rows.push({
      source: SEC_FORM4_BUY_SOURCE,
      symbol: resolved.symbol,
      known_at_ms: knownAtMsFor(b.filingDate),
      weight,
      meta_json: JSON.stringify({
        accession: b.accession,
        form: b.form,
        role: roles,
        actors: [actor],
        insiderClass,
        owners: b.owners.map(o => ({ cik: o.cik, name: o.name, roles: o.roles, title: o.title })),
        shares: b.shares,
        price: b.price,
        txDate: b.txDate,
        filingDate: b.filingDate,
        lagDays,
        issuerCik: b.issuerCik,
        issuerName: b.issuerName,
        rawTicker: b.rawTicker,
        security: b.security.slice(0, 80),
        sp500: resolved.mapped,
        plan10b5_1: planSource !== null,
        plan10b5_1Source: planSource,
        plan10b5_1Field: b.plan.checkbox !== null,
        ...(suspect ? { suspectDollars: rawDollars } : {}),
      }),
    });
  }
  return { rows, stats };
}

// ── descriptive statistics (counts and lags only — NO prices, NO returns) ─

export interface YearStats {
  events: number; sp500Events: number; sp500Share: number; symbols: number; sp500Symbols: number; filings: number; pricedEvents: number; dollars: number;
  officerOrDirectorEvents: number;
  /** Insider class of the events (all events / S&P-mapped officer-or-director events). */
  classAll: Record<InsiderClass, number>;
  classSp500OfficerDirector: Record<InsiderClass, number>;
  /** Rule 10b5-1: events whose filing carried the checkbox column filled in, events flagged by each trace, flagged by any. */
  plan: { fieldPresent: number; flaggedCheckbox: number; flaggedFootnote: number; flaggedRemarks: number; flaggedAny: number; fieldPresentFlaggedShare: number };
  /** Events reported more than 30 days after the transaction (stale), all / S&P-mapped / S&P-mapped officer-or-director. */
  lagOver30: { all: number; sp500: number; sp500OfficerDirector: number };
  /** Filings listing more than one reporting owner. */
  jointFilings: number;
}

export interface SecStats {
  source: string;
  rows: number;
  firstKnownIso: string | null;
  lastKnownIso: string | null;
  byYear: Record<string, YearStats>;
  total: {
    events: number; sp500Events: number; sp500Share: number; pricedEvents: number; officerOrDirectorEvents: number; tenPercentOnlyEvents: number;
    classAll: Record<InsiderClass, number>; classSp500OfficerDirector: Record<InsiderClass, number>;
    plan: YearStats["plan"]; lagOver30: YearStats["lagOver30"]; jointFilings: number;
  };
  /** Calendar days between the transaction and the filing date (the information lag). */
  lagDays: { n: number; mean: number; p10: number; p25: number; p50: number; p75: number; p90: number; p99: number; max: number; share0to2: number; shareOver5: number; over30: number; over365: number; negative: number };
  /** Dollar value of the events mapped to point-in-time index members (priced events only). */
  sp500Dollars: { n: number; p50: number; p90: number; max: number; over1e9: number };
  quarters: Record<string, number>;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const zeroClasses = (): Record<InsiderClass, number> => ({ opportunistic: 0, routine: 0, unknown: 0 });
const zeroPlan = (): YearStats["plan"] => ({ fieldPresent: 0, flaggedCheckbox: 0, flaggedFootnote: 0, flaggedRemarks: 0, flaggedAny: 0, fieldPresentFlaggedShare: 0 });

export function summarizeRows(rows: readonly SignalRow[]): SecStats {
  const byYear: SecStats["byYear"] = {};
  const sets: Record<string, { symbols: Set<string>; sp: Set<string>; filings: Set<string> }> = {};
  const lags: number[] = [];
  const spDollars: number[] = [];
  const quarters: Record<string, number> = {};
  const total = { classAll: zeroClasses(), classSp500OfficerDirector: zeroClasses(), plan: zeroPlan(), lagOver30: { all: 0, sp500: 0, sp500OfficerDirector: 0 }, jointFilings: 0 };
  let sp = 0, priced = 0, od = 0, tenOnly = 0, first = Infinity, last = -Infinity;
  for (const r of rows) {
    const m = JSON.parse(r.meta_json) as {
      sp500?: boolean; role?: string[]; accession?: string; lagDays?: number | null; filingDate?: string; insiderClass?: InsiderClass;
      plan10b5_1Field?: boolean; plan10b5_1Source?: string | null; owners?: unknown[];
    };
    const date = m.filingDate ?? new Date(r.known_at_ms).toISOString().slice(0, 10);
    const y = date.slice(0, 4);
    const q = `${y}q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
    quarters[q] = (quarters[q] ?? 0) + 1;
    const s = (sets[y] ??= { symbols: new Set(), sp: new Set(), filings: new Set() });
    const b = (byYear[y] ??= {
      events: 0, sp500Events: 0, sp500Share: 0, symbols: 0, sp500Symbols: 0, filings: 0, pricedEvents: 0, dollars: 0, officerOrDirectorEvents: 0,
      classAll: zeroClasses(), classSp500OfficerDirector: zeroClasses(), plan: zeroPlan(), lagOver30: { all: 0, sp500: 0, sp500OfficerDirector: 0 }, jointFilings: 0,
    });
    b.events++;
    s.symbols.add(r.symbol);
    if (m.accession) s.filings.add(m.accession);
    const isSp = m.sp500 === true;
    if (isSp) { b.sp500Events++; s.sp.add(r.symbol); sp++; if (r.weight > 0) spDollars.push(r.weight); }
    if (r.weight > 0) { b.pricedEvents++; b.dollars += r.weight; priced++; }
    const roles = m.role ?? [];
    const isOd = roles.includes("officer") || roles.includes("director");
    if (isOd) { b.officerOrDirectorEvents++; od++; }
    else if (roles.includes("tenPercentOwner")) tenOnly++;
    const cls = m.insiderClass ?? "unknown";
    b.classAll[cls]++; total.classAll[cls]++;
    if (isSp && isOd) { b.classSp500OfficerDirector[cls]++; total.classSp500OfficerDirector[cls]++; }
    for (const p of [b.plan, total.plan]) {
      if (m.plan10b5_1Field) p.fieldPresent++;
      if (m.plan10b5_1Source === "checkbox") p.flaggedCheckbox++;
      else if (m.plan10b5_1Source === "footnote") p.flaggedFootnote++;
      else if (m.plan10b5_1Source === "remarks") p.flaggedRemarks++;
      if (m.plan10b5_1Source) p.flaggedAny++;
    }
    if ((m.owners?.length ?? 0) > 1) { b.jointFilings++; total.jointFilings++; }
    if (typeof m.lagDays === "number") {
      lags.push(m.lagDays);
      if (m.lagDays > 30) for (const l of [b.lagOver30, total.lagOver30]) { l.all++; if (isSp) l.sp500++; if (isSp && isOd) l.sp500OfficerDirector++; }
    }
    first = Math.min(first, r.known_at_ms);
    last = Math.max(last, r.known_at_ms);
  }
  for (const [y, b] of Object.entries(byYear)) {
    b.symbols = sets[y].symbols.size;
    b.sp500Symbols = sets[y].sp.size;
    b.filings = sets[y].filings.size;
    b.sp500Share = b.events > 0 ? b.sp500Events / b.events : 0;
    b.dollars = Math.round(b.dollars);
    b.plan.fieldPresentFlaggedShare = b.plan.fieldPresent > 0 ? b.plan.flaggedCheckbox / b.plan.fieldPresent : 0;
  }
  total.plan.fieldPresentFlaggedShare = total.plan.fieldPresent > 0 ? total.plan.flaggedCheckbox / total.plan.fieldPresent : 0;
  const sorted = [...lags].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    source: SEC_FORM4_BUY_SOURCE,
    rows: rows.length,
    firstKnownIso: Number.isFinite(first) ? new Date(first).toISOString() : null,
    lastKnownIso: Number.isFinite(last) ? new Date(last).toISOString() : null,
    byYear: Object.fromEntries(Object.entries(byYear).sort(([a], [b]) => (a < b ? -1 : 1))),
    total: { events: rows.length, sp500Events: sp, sp500Share: rows.length > 0 ? sp / rows.length : 0, pricedEvents: priced, officerOrDirectorEvents: od, tenPercentOnlyEvents: tenOnly, ...total },
    lagDays: {
      n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : NaN,
      p10: quantile(sorted, 0.1), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p90: quantile(sorted, 0.9), p99: quantile(sorted, 0.99),
      max: n ? sorted[n - 1] : NaN,
      share0to2: n ? sorted.filter(x => x >= 0 && x <= 2).length / n : NaN,
      shareOver5: n ? sorted.filter(x => x > 5).length / n : NaN,
      over30: sorted.filter(x => x > 30).length,
      over365: sorted.filter(x => x > 365).length,
      negative: sorted.filter(x => x < 0).length,
    },
    sp500Dollars: (() => {
      const d = [...spDollars].sort((a, b) => a - b);
      return { n: d.length, p50: quantile(d, 0.5), p90: quantile(d, 0.9), max: d.length ? d[d.length - 1] : NaN, over1e9: d.filter(x => x > 1e9).length };
    })(),
    quarters: Object.fromEntries(Object.entries(quarters).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
