import { t } from "./store.js";
// ── fmt.js — the ONE source of formatting. v3's bugs came from many divergent
// copies of "today" / money / pct / date helpers. Everything formats here.

const ET = "America/New_York";

/** Coerce to a finite number or fall back (guards NaN/Infinity/null the API leaks). */
export function n(v, fallback = 0) {
  const x = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
}

/** 1234.5 -> "1,234.50" (no sign, no $). */
export function num(v, d = 2) {
  return n(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 1234.5 -> "$1,234.50". */
export function money(v, d = 2) {
  return "$" + num(Math.abs(n(v)), d);
}

/** -3.6 -> "−$3.60" (unicode minus, always signed). Use for P&L. */
export function moneySigned(v, d = 2) {
  const x = n(v);
  return (x < 0 ? "−" : "+") + "$" + num(Math.abs(x), d);
}

/** Table money: whole dollars from $100; up to 3 significant digits below. */
export function moneyCompact(v) {
  const x = Math.abs(n(v));
  return "$" + (x >= 100 ? num(x, 0) : x.toLocaleString("en-US", { maximumSignificantDigits: 3 }));
}

export function moneySignedCompact(v) {
  return (n(v) < 0 ? "−" : "+") + moneyCompact(v);
}

/** P&L in a table: whole dollars always (owner, 2026-10-25: "no necesito decimales"). */
export function pnlWhole(v) {
  const x = Math.round(n(v));
  return (x < 0 ? "−" : "+") + "$" + num(Math.abs(x), 0);
}

/** Table units: whole from 1 (the exact quantity rides in the cell's title);
 *  3 significant digits below 1, so crypto units like 0.0123 never read 0. */
export function quantity(v) {
  if (v == null || v === "") return "—";
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1) return num(x, 0);
  return x.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** 12.3 -> "12.3%" (value is already a percent, 0..100). */
export function pct(v, d = 1) {
  return num(v, d) + "%";
}

/** 12.3 -> "+12.3%" / -1 -> "−1.0%". */
export function pctSigned(v, d = 1) {
  const x = n(v);
  return (x < 0 ? "−" : "+") + num(Math.abs(x), d) + "%";
}

/** A 0..1 fraction -> "42%" (some analytics endpoints return fractions). */
export function pctFrac(v, d = 0) {
  return num(n(v) * 100, d) + "%";
}

/** css var name for a P&L sign. */
export function pnlColor(v) {
  return n(v) >= 0 ? "var(--up)" : "var(--down)";
}

/** ET clock, e.g. "11:05 PM". */
export function etTime(ms) {
  return new Date(n(ms, Date.now())).toLocaleTimeString("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit" });
}

/** ET date, e.g. "Jul 1". */
export function etDate(ms) {
  return new Date(n(ms, Date.now())).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" });
}

/** ET date + time, e.g. "Jul 1, 11:05 PM". */
export function etDateTime(ms) {
  return etDate(ms) + ", " + etTime(ms);
}

/** Relative age: "just now" / "5m" / "3h" / "2d" / date. Handles ms epoch. */
export function ago(ms) {
  const ts = n(ms, 0);
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return t("just now", "ahora");
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m}m ago`, `hace ${m} min`);
  const h = Math.floor(m / 60);
  if (h < 24) return t(`${h}h ago`, `hace ${h} h`);
  const d = Math.floor(h / 24);
  if (d < 30) return t(`${d}d ago`, `hace ${d} d`);
  return etDate(ts);
}

/** Duration in ms -> "3h 12m" / "45m" / "12s". */
export function dur(ms) {
  const s = Math.max(0, Math.floor(n(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
