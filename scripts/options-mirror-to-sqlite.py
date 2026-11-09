#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=15"]
# ///
"""
Vega phase R (quorum Q9, experiments/options-vega-r-v1.json), step 1: mirror -> SQLite + audit.

1. Downloads the four data-v1 parquet files of lambdaclass/options_portfolio_backtester into
   $UC_RESEARCH_DATA_DIR/options-mirror/ (skipped when present) and verifies their SHA-256
   against the FROZEN manifest. A mismatch stops everything: nothing is written.
2. Writes $UC_RESEARCH_DATA_DIR/hist-options.db:
     underlying_daily      raw OHLC, adjusted close, dividends, splits (both parquets, every row)
     mirror_options        the manifest's storedSubset: 0 <= calendar days to expiration <= 12 and
                           0.80 <= strike / raw underlying close <= 1.20 (streamed by row group)
     mirror_listed         every (underlying, session, expiration) present in the FULL files, with its
                           row count: the calendar's "listed expirations" and the eligibility audit
   Tables that belong to other steps (alpaca_*) are left untouched so a rerun never destroys them.
3. Audits the FULL files per data.primary.auditGate.checks and writes
   $UC_RESEARCH_DATA_DIR/hist-options-audit.json: hashes, coverage per year, weekly eligibility
   (the frozen calendar rule), quote quality, the second-provider spread model (median relative
   spread at the entry snapshots of the mirror's last 252 sessions, by underlying, type and
   |delta| bucket, delta from the frozen Black-Scholes rule) and the results-blind primary-window
   start per underlying (windows.primary: first entry session from which >= 95 % of the next 52
   weeks have an eligible expiration).

Data convention declared here (not a manifest change): until 2015 the mirror dates monthly
expirations on the SATURDAY after the third Friday (the old OPRA convention); weeklies and later
monthlies carry the Friday. The expiration SESSION of a listed expiration E is the last session
<= E (Saturday -> the preceding Friday), so "the session before E" is always the session before the
contract's last trading day, as the frozen rule intends ("never hold a leg into the expiration
session"). T for Black-Scholes is counted to that session. The audit reports the weekday
distribution so the reader can see how many expirations this touched.

Research-only data (mirror license): never committed, never republished.

Usage: uv run scripts/options-mirror-to-sqlite.py [--skip-download] [--audit-only]
"""
from __future__ import annotations

import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
import os
import sqlite3
import statistics
import sys
import time
import urllib.request
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "experiments" / "options-vega-r-v1.json"
FILES = ["SPY_options.parquet", "SPY_underlying.parquet", "QQQ_options.parquet", "QQQ_underlying.parquet"]
UNDERLYINGS = ["SPY", "QQQ"]
DELTA_BUCKETS = [(0.0, 0.15), (0.15, 0.35), (0.35, 0.65)]
IV_LO, IV_HI, IV_TOL, IV_ITERS = 0.005, 5.0, 1e-6, 100


def research_dir() -> Path:
    v = os.environ.get("UC_RESEARCH_DATA_DIR", "").strip()
    return Path(v) if v else Path.home() / "code" / "wt" / "data"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── download + hash ──────────────────────────────────────────────────────────────────────────────

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    log(f"downloading {url} -> {dest}")
    with urllib.request.urlopen(url, timeout=120) as r, part.open("wb") as out:
        while True:
            chunk = r.read(1 << 22)
            if not chunk:
                break
            out.write(chunk)
    part.rename(dest)


def ensure_files(manifest: dict, mirror_dir: Path, skip_download: bool) -> dict:
    release = manifest["data"]["primary"]["release"]  # .../releases/tag/data-v1 (GitHub follows renames)
    base = release.replace("/releases/tag/", "/releases/download/") + "/"
    mirror_dir.mkdir(parents=True, exist_ok=True)
    expected = manifest["data"]["primary"]["sha256"]
    out = {}
    for name in FILES:
        path = mirror_dir / name
        if not path.exists():
            if skip_download:
                raise SystemExit(f"missing {path} and --skip-download given")
            download(base + name, path)
        actual = sha256_of(path)
        out[name] = {"sha256": actual, "expected": expected[name], "match": actual == expected[name], "bytes": path.stat().st_size}
        log(f"{name}: sha256 {actual[:16]}... {'OK' if out[name]['match'] else 'MISMATCH'}")
    if not all(v["match"] for v in out.values()):
        raise SystemExit("SHA-256 mismatch against the frozen manifest: nothing written (auditGate.onFailure)")
    return out


# ── Black-Scholes (r = 0, q = 0), identical to scripts/lib/optionsWeekly.ts ──────────────────────

def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def bs_price(S: float, K: float, T: float, sigma: float, is_call: bool) -> float:
    if T <= 0 or sigma <= 0:
        return max(0.0, S - K) if is_call else max(0.0, K - S)
    sq = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sigma * sigma * T) / sq
    d2 = d1 - sq
    if is_call:
        return S * norm_cdf(d1) - K * norm_cdf(d2)
    return K * norm_cdf(-d2) - S * norm_cdf(-d1)


def bs_delta(S: float, K: float, T: float, sigma: float, is_call: bool) -> float:
    sq = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sigma * sigma * T) / sq
    return norm_cdf(d1) if is_call else norm_cdf(d1) - 1.0


def implied_vol(S: float, K: float, T: float, mid: float, is_call: bool):
    """Bisection on [0.005, 5.0], tolerance 1e-6 in price, <= 100 iterations; None = unusable."""
    intrinsic = max(0.0, S - K) if is_call else max(0.0, K - S)
    if not (mid >= intrinsic) or T <= 0:
        return None
    lo, hi = IV_LO, IV_HI
    if mid < bs_price(S, K, T, lo, is_call) or mid > bs_price(S, K, T, hi, is_call):
        return None
    for _ in range(IV_ITERS):
        m = 0.5 * (lo + hi)
        p = bs_price(S, K, T, m, is_call)
        if abs(p - mid) <= IV_TOL:
            return m
        if p < mid:
            lo = m
        else:
            hi = m
    return None


def usable_quote(bid, ask) -> bool:
    if bid is None or ask is None or not (ask > 0) or not (bid >= 0) or ask < bid:
        return False
    mid = 0.5 * (bid + ask)
    return (ask - bid) <= max(0.25, 0.5 * mid)


# ── SQLite ───────────────────────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS underlying_daily (
  symbol TEXT NOT NULL, date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL NOT NULL, adjusted_close REAL NOT NULL,
  volume INTEGER, dividend_amount REAL NOT NULL DEFAULT 0, split_coefficient REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS mirror_options (
  underlying TEXT NOT NULL, date TEXT NOT NULL, expiration TEXT NOT NULL, type TEXT NOT NULL, strike REAL NOT NULL,
  bid REAL, ask REAL, last REAL, volume INTEGER, open_interest INTEGER,
  implied_volatility REAL, delta REAL,
  PRIMARY KEY (underlying, date, expiration, type, strike)
);
CREATE TABLE IF NOT EXISTS mirror_listed (
  underlying TEXT NOT NULL, date TEXT NOT NULL, expiration TEXT NOT NULL, rows INTEGER NOT NULL,
  PRIMARY KEY (underlying, date, expiration)
);
CREATE TABLE IF NOT EXISTS mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def open_db(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(str(path))
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA temp_store=MEMORY")
    db.executescript(SCHEMA)
    return db


def load_underlying(db: sqlite3.Connection, mirror_dir: Path) -> dict:
    closes: dict[str, dict[str, float]] = {}
    db.execute("DELETE FROM underlying_daily")
    for u in UNDERLYINGS:
        t = pq.read_table(mirror_dir / f"{u}_underlying.parquet")
        rows = t.to_pylist()
        db.executemany(
            "INSERT INTO underlying_daily VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(u, r["date"], r["open"], r["high"], r["low"], r["close"], r["adjusted_close"], r["volume"],
              r["dividend_amount"] or 0.0, r["split_coefficient"] or 1.0) for r in rows],
        )
        closes[u] = {r["date"]: float(r["close"]) for r in rows}
        log(f"{u} underlying: {len(rows)} sessions {rows[0]['date']} -> {rows[-1]['date']}")
    db.commit()
    return closes


def convert_options(db: sqlite3.Connection, mirror_dir: Path, u: str, raw_close: dict[str, float]) -> dict:
    pf = pq.ParquetFile(mirror_dir / f"{u}_options.parquet")
    schema = [(f.name, str(f.type)) for f in pf.schema_arrow]
    names = {n for n, _ in schema}
    for col in ("bid", "ask", "implied_volatility", "expiration", "strike", "type", "date"):
        if col not in names:
            raise SystemExit(f"{u}_options.parquet lacks column {col}: auditGate fails (no bid/ask)")
    db.execute("DELETE FROM mirror_options WHERE underlying = ?", (u,))
    db.execute("DELETE FROM mirror_listed WHERE underlying = ?", (u,))

    dates_arr = pa.array(sorted(raw_close.keys()), pa.string())
    closes_arr = pa.array([raw_close[d] for d in dates_arr.to_pylist()], pa.float64())

    rows_by_year: collections.Counter = collections.Counter()
    sessions: set[str] = set()
    quality: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)
    listed: collections.Counter = collections.Counter()
    exp_weekday: collections.Counter = collections.Counter()  # (year of expiration, weekday) -> set handled below
    exp_seen: set[str] = set()
    types_seen: set[str] = set()
    rows_total = rows_without_close = subset_rows = 0

    for rg in range(pf.metadata.num_row_groups):
        t = pf.read_row_group(rg, columns=["expiration", "strike", "type", "bid", "ask", "last", "volume",
                                           "open_interest", "date", "implied_volatility", "delta"])
        n = t.num_rows
        rows_total += n
        date_s = pc.strftime(t["date"], format="%Y-%m-%d")
        exp_s = pc.strftime(t["expiration"], format="%Y-%m-%d")
        bid, ask, iv = t["bid"], t["ask"], t["implied_volatility"]
        years = pc.year(t["date"]).to_pylist()
        # quality (full file)
        for y, cnt in collections.Counter(years).items():
            rows_by_year[y] += cnt
        ydict = pa.array(years)
        for y in set(years):
            m = pc.equal(ydict, y)
            q = quality[y]
            q["rows"] += pc.sum(m).as_py()
            q["bidNull"] += pc.sum(pc.and_(m, pc.is_null(bid))).as_py()
            q["askNull"] += pc.sum(pc.and_(m, pc.is_null(ask))).as_py()
            q["ivNull"] += pc.sum(pc.and_(m, pc.is_null(iv))).as_py()
            q["askLtBid"] += pc.sum(pc.and_(m, pc.fill_null(pc.less(ask, bid), False))).as_py()
            q["askLe0"] += pc.sum(pc.and_(m, pc.fill_null(pc.less_equal(ask, 0), False))).as_py()
            q["bidEq0"] += pc.sum(pc.and_(m, pc.fill_null(pc.equal(bid, 0), False))).as_py()
        sessions.update(pc.unique(date_s).to_pylist())
        exp_seen.update(pc.unique(exp_s).to_pylist())
        types_seen.update(pc.unique(t["type"]).to_pylist())
        # listed expirations per session
        g = pa.table({"date": date_s, "expiration": exp_s, "one": pa.array([1] * n, pa.int32())}) \
            .group_by(["date", "expiration"]).aggregate([("one", "sum")])
        for d, e, c in zip(g["date"].to_pylist(), g["expiration"].to_pylist(), g["one_sum"].to_pylist()):
            listed[(d, e)] += c
        # stored subset
        idx = pc.index_in(date_s, value_set=dates_arr)
        close = pc.take(closes_arr, idx)  # null where the session is not in the underlying
        rows_without_close += pc.sum(pc.is_null(close)).as_py()
        days = pc.days_between(t["date"], t["expiration"])
        ratio = pc.divide(t["strike"], close)
        mask = pc.and_(pc.and_(pc.greater_equal(days, 0), pc.less_equal(days, 12)),
                       pc.and_(pc.greater_equal(ratio, 0.8), pc.less_equal(ratio, 1.2)))
        mask = pc.fill_null(mask, False)
        sub = pa.table({"date": date_s, "expiration": exp_s, "type": pc.cast(t["type"], pa.string()), "strike": t["strike"],
                        "bid": bid, "ask": ask, "last": t["last"], "volume": t["volume"], "open_interest": t["open_interest"],
                        "iv": iv, "delta": t["delta"]}).filter(mask)
        cols = [sub[c].to_pylist() for c in sub.column_names]
        db.executemany(
            "INSERT OR REPLACE INTO mirror_options VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(u, d, e, ty, k, b, a, la, v, oi, i, de) for d, e, ty, k, b, a, la, v, oi, i, de in zip(*cols)],
        )
        subset_rows += sub.num_rows
        if rg % 10 == 0 or rg == pf.metadata.num_row_groups - 1:
            log(f"{u} row group {rg + 1}/{pf.metadata.num_row_groups}: {rows_total:,} rows read, {subset_rows:,} stored")
            db.commit()
    db.executemany("INSERT INTO mirror_listed VALUES (?,?,?,?)", [(u, d, e, c) for (d, e), c in listed.items()])
    db.commit()
    for e in exp_seen:
        y, m, d = map(int, e.split("-"))
        exp_weekday[(y, dt.date(y, m, d).weekday())] += 1
    by_year = collections.defaultdict(dict)
    for (y, wd), c in sorted(exp_weekday.items()):
        by_year[y][["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd]] = c
    sess = sorted(sessions)
    sess_by_year = collections.Counter(int(s[:4]) for s in sess)
    return {
        "schema": schema,
        "types": sorted(types_seen),
        "rows": rows_total,
        "storedRows": subset_rows,
        "rowsWithoutUnderlyingClose": rows_without_close,
        "firstDate": sess[0], "lastDate": sess[-1], "sessions": len(sess),
        "perYear": {str(y): {"sessions": sess_by_year[y], "rows": rows_by_year[y]} for y in sorted(rows_by_year)},
        "quoteQuality": {str(y): dict(quality[y]) for y in sorted(quality)},
        "expirationsByWeekday": {str(y): v for y, v in sorted(by_year.items())},
        "sessionsNotInUnderlying": sorted(set(sess) - set(raw_close.keys())),
    }


# ── calendar (frozen rule; mirrored by scripts/lib/optionsWeekly.ts) ──────────────────────────────

def build_weeks(sessions: list[str]) -> list[dict]:
    groups: dict[tuple, list[str]] = collections.OrderedDict()
    for s in sessions:
        y, m, d = map(int, s.split("-"))
        key = dt.date(y, m, d).isocalendar()[:2]
        groups.setdefault(key, []).append(s)
    weeks = []
    for key, ss in groups.items():
        if len(ss) < 2:
            continue
        weeks.append({"isoWeek": f"{key[0]}-W{key[1]:02d}", "sessions": ss, "entry": ss[-1], "signal": ss[-2]})
    return weeks


def eligible_expiration(sessions: list[str], pos: dict[str, int], entry: str, listed: list[str]):
    """Last listed E with 2 <= sessions(entry, E] <= 5; returns (E, expirationSession, exitSession) or None."""
    best = None
    i0 = pos[entry]
    for e in listed:
        # expiration session = last session <= E
        j = bisect.bisect_right(sessions, e) - 1
        if j <= i0:
            continue
        count = j - i0
        if 2 <= count <= 5 and (best is None or e > best[0]):
            best = (e, sessions[j], sessions[j - 1])
    return best


def audit_calendar(db: sqlite3.Connection, sessions: list[str], first_opt: dict[str, str], last_opt: dict[str, str]) -> dict:
    pos = {s: i for i, s in enumerate(sessions)}
    weeks = build_weeks(sessions)
    listed_by: dict[str, dict[str, list[str]]] = {u: collections.defaultdict(list) for u in UNDERLYINGS}
    for u, d, e in db.execute("SELECT underlying, date, expiration FROM mirror_listed ORDER BY 1,2,3"):
        listed_by[u][d].append(e)
    out = {}
    for u in UNDERLYINGS:
        rows = []
        for w in weeks:
            if w["entry"] < first_opt[u] or w["entry"] > last_opt[u]:
                continue
            el = eligible_expiration(sessions, pos, w["entry"], listed_by[u].get(w["entry"], []))
            rows.append({"isoWeek": w["isoWeek"], "entry": w["entry"], "signal": w["signal"],
                         "expiration": el[0] if el else None, "expirationSession": el[1] if el else None,
                         "exit": el[2] if el else None, "listed": len(listed_by[u].get(w["entry"], []))})
        per_year = collections.defaultdict(lambda: {"weeks": 0, "eligible": 0})
        for r in rows:
            y = r["entry"][:4]
            per_year[y]["weeks"] += 1
            per_year[y]["eligible"] += r["expiration"] is not None
        start = None
        need = math.ceil(0.95 * 52)
        for i in range(len(rows) - 51):
            if sum(r["expiration"] is not None for r in rows[i:i + 52]) >= need:
                start = rows[i]["entry"]
                break
        out[u] = {"weeks": rows, "perYear": dict(per_year), "primaryWindowStart": start,
                  "primaryWindowRule": f"first entry session from which >= {need} of the 52 weeks starting there have an eligible expiration"}
        log(f"{u}: {len(rows)} weeks, {sum(r['expiration'] is not None for r in rows)} eligible, primary window start {start}")
    return out


def entry_chains_full(mirror_dir: Path, u: str, wanted: dict[str, str]):
    """(type, strike, bid, ask) rows of the FULL parquet for the wanted {entry date: expiration} snapshots."""
    path = mirror_dir / f"{u}_options.parquet"
    dates = pa.array([dt.datetime.fromisoformat(d) for d in sorted(wanted)], pa.timestamp("ns"))
    t = pq.read_table(path, columns=["date", "expiration", "type", "strike", "bid", "ask"],
                      filters=[("date", "in", dates)])
    date_s = pc.strftime(t["date"], format="%Y-%m-%d").to_pylist()
    exp_s = pc.strftime(t["expiration"], format="%Y-%m-%d").to_pylist()
    out: dict[str, list] = collections.defaultdict(list)
    for d, e, ty, k, b, a in zip(date_s, exp_s, pc.cast(t["type"], pa.string()).to_pylist(), t["strike"].to_pylist(),
                                 t["bid"].to_pylist(), t["ask"].to_pylist()):
        if wanted.get(d) == e:
            out[d].append((ty, k, b, a))
    return out


def audit_spread_model(db: sqlite3.Connection, sessions: list[str], calendar: dict, raw_close: dict, last_date: str,
                       mirror_dir: Path, source: str) -> dict:
    """Median relative spread (ask - bid) / mid at entry snapshots in the mirror's last 252 sessions.
    source = "full" reads the complete parquet chains of those snapshots (the manifest's audit basis);
    source = "storedSubset" reads mirror_options (diagnostic only)."""
    end_i = sessions.index(last_date)
    first = sessions[max(0, end_i - 251)]
    out = {"source": source, "window": {"firstSession": first, "lastSession": last_date, "sessions": end_i - sessions.index(first) + 1},
           "buckets": [list(b) for b in DELTA_BUCKETS], "cells": {}}
    for u in UNDERLYINGS:
        samples: dict[tuple, list[float]] = collections.defaultdict(list)
        entries = 0
        snaps = [w for w in calendar[u]["weeks"] if w["expiration"] is not None and first <= w["entry"] <= last_date]
        full = entry_chains_full(mirror_dir, u, {w["entry"]: w["expiration"] for w in snaps}) if source == "full" else None
        for w in snaps:
            entries += 1
            S = raw_close[u][w["entry"]]
            T = (dt.date.fromisoformat(w["expirationSession"]) - dt.date.fromisoformat(w["entry"])).days / 365.0
            rows = full[w["entry"]] if full is not None else db.execute(
                "SELECT type, strike, bid, ask FROM mirror_options WHERE underlying=? AND date=? AND expiration=?",
                (u, w["entry"], w["expiration"])).fetchall()
            for ty, K, bid, ask in rows:
                if not usable_quote(bid, ask):
                    continue
                mid = 0.5 * (bid + ask)
                iv = implied_vol(S, K, T, mid, ty == "call")
                if iv is None:
                    continue
                ad = abs(bs_delta(S, K, T, iv, ty == "call"))
                for lo, hi in DELTA_BUCKETS:
                    if (lo <= ad < hi) or (hi == 0.65 and ad == hi):
                        samples[(ty, lo, hi)].append((ask - bid) / mid)
                        break
        for (ty, lo, hi), xs in sorted(samples.items()):
            out["cells"][f"{u}|{ty}|{lo}-{hi}"] = {"underlying": u, "type": ty, "absDeltaBucket": [lo, hi], "n": len(xs),
                                                   "medianRelativeSpread": statistics.median(xs), "h": statistics.median(xs) / 2}
        out[u] = {"entrySnapshots": entries}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--audit-only", action="store_true", help="reuse hist-options.db, recompute the audit only")
    args = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    rd = research_dir()
    mirror_dir = rd / "options-mirror"
    db_path = rd / "hist-options.db"
    audit_path = rd / "hist-options-audit.json"
    hashes = ensure_files(manifest, mirror_dir, args.skip_download)

    db = open_db(db_path)
    raw_close = {u: {d: c for d, c in db.execute("SELECT date, close FROM underlying_daily WHERE symbol=? ORDER BY date", (u,))} for u in UNDERLYINGS} \
        if args.audit_only else load_underlying(db, mirror_dir)
    coverage = {}
    if args.audit_only:
        coverage = json.loads(db.execute("SELECT value FROM mirror_meta WHERE key='coverage'").fetchone()[0])
    else:
        for u in UNDERLYINGS:
            coverage[u] = convert_options(db, mirror_dir, u, raw_close[u])
        db.execute("INSERT OR REPLACE INTO mirror_meta VALUES ('coverage', ?)", (json.dumps(coverage),))
        db.execute("INSERT OR REPLACE INTO mirror_meta VALUES ('sha256', ?)", (json.dumps({k: v["sha256"] for k, v in hashes.items()}),))
        db.execute("INSERT OR REPLACE INTO mirror_meta VALUES ('convertedAt', ?)", (dt.datetime.now(dt.timezone.utc).isoformat(),))
        db.commit()
        log("creating index on mirror_options(underlying, date)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_mirror_options_ud ON mirror_options(underlying, date)")
        db.commit()

    sessions = sorted(raw_close["SPY"].keys())  # the manifest's sessions: SPY daily closes
    first_opt = {u: coverage[u]["firstDate"] for u in UNDERLYINGS}
    last_opt = {u: coverage[u]["lastDate"] for u in UNDERLYINGS}
    mirror_last = coverage["SPY"]["lastDate"]
    calendar = audit_calendar(db, sessions, first_opt, last_opt)
    log("spread model on the FULL entry chains (manifest basis)")
    spread = audit_spread_model(db, sessions, calendar, raw_close, mirror_last, mirror_dir, "full")
    spread_subset = audit_spread_model(db, sessions, calendar, raw_close, mirror_last, mirror_dir, "storedSubset")

    has_bid_ask = all(all(c in {n for n, _ in coverage[u]["schema"]} for c in ("bid", "ask", "implied_volatility")) for u in UNDERLYINGS)
    weekly = {u: calendar[u]["primaryWindowStart"] is not None for u in UNDERLYINGS}
    gate = {"sha256": True, "bidAskPresent": has_bid_ask, "weeklyExpirations": weekly, "pass": has_bid_ask and all(weekly.values())}
    audit = {
        "manifest": "experiments/options-vega-r-v1.json",
        "auditedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "resultsBlind": True,
        "files": hashes,
        "dbPath": str(db_path),
        "sessionsSource": "SPY_underlying.parquet dates",
        "sessions": {"first": sessions[0], "last": sessions[-1], "count": len(sessions)},
        "mirrorLastOptionsDate": mirror_last,
        "expirationDating": "the expiration session of a listed E is the last session <= E (pre-2015 monthlies are dated Saturday); exit = the session before it; T counts to it",
        "coverage": coverage,
        "calendar": {u: {k: v for k, v in calendar[u].items() if k != "weeks"} for u in UNDERLYINGS},
        "weeks": {u: calendar[u]["weeks"] for u in UNDERLYINGS},
        "spreadModel": spread,
        "spreadModelStoredSubsetDiagnostic": spread_subset,
        "gate": gate,
    }
    audit_path.write_text(json.dumps(audit, indent=1))
    log(f"audit written to {audit_path}; gate {'PASS' if gate['pass'] else 'FAIL'}")
    for u in UNDERLYINGS:
        c = coverage[u]
        log(f"{u}: {c['rows']:,} rows, {c['storedRows']:,} stored, {c['firstDate']} -> {c['lastDate']}, window start {calendar[u]['primaryWindowStart']}")
    for k, v in spread["cells"].items():
        log(f"spread {k}: n={v['n']} median={v['medianRelativeSpread']:.4f} h={v['h']:.4f}")
    db.close()
    if not gate["pass"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
