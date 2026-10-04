import { store, t, periodLabel } from "../store.js";
import { api } from "../api.js";
import { money, moneySigned, pctSigned, pnlColor, n, etTime, etDate } from "../fmt.js";
import { esc } from "../ui.js";

// No emojis (v3 deliberately removed them as an AI-fingerprint). A small colored
// dot per profile carries the same signal — deterministic per id so it stays
// stable across reloads without a hardcoded id→color table (sleeves come and
// go; am.getAccountSummaries() is the live source of truth for which exist).
const DOT_PALETTE = ["var(--up)", "var(--accent)", "#a855f7", "#f59e0b", "var(--down)", "#22c55e"];
// Exported: positions.js reuses the exact same id->color mapping for its
// per-row sleeve badge, so a sleeve is the same color everywhere in the UI.
export function dotColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length];
}

export function statsById(profiles) {
  const map = {};
  for (const p of profiles || []) for (const ba of p.brokerAccounts || []) {
    for (const [id, st] of Object.entries(ba.perAccountStats || {})) map[id] = st;
  }
  return map;
}

export const brokerKey = (b) => String(b || "").split("_")[0];
export const BROKER_LABEL = { alpaca: "Alpaca", binance: "Binance" };

// One aggregated card per broker (Alpaca / Binance) — the 5 sleeves live
// behind the "Details →" modal (broker-modal.js) so the top grid stays 2
// cards instead of a 2x2+1 block of near-duplicate chrome.
function brokerCard(key, group, bt, stats) {
  // Headline numbers come from BROKER-TRUTH (bt = the v2 brokerAccounts entry:
  // the same `${broker}_main` snapshot source the header pill and the TODAY/ALL
  // KPIs use), so the two broker cards SUM to the headline KPI. The old per-
  // sleeve sums (kept as a fallback) miss unrealized P&L on open positions —
  // which is exactly why Alpaca −24 + Binance +28 didn't reconcile with −298.
  const btOk = !!(bt && bt.equity != null);
  const equity = btOk ? n(bt.equity) : group.reduce((s, a) => s + n(a.equity), 0);
  const first = n(bt?.firstEquity);
  const allPnl = btOk && first > 0 ? n(bt.equity) - first : group.reduce((s, a) => s + n(a.totalPnl), 0);
  const allBase = btOk && first > 0 ? first : group.reduce((s, a) => s + n(a.initialEquity), 0);
  const allPct = allBase > 0 ? (allPnl / allBase) * 100 : 0;
  const periodPnl = btOk && bt.stats?.periodEquityPnl != null
    ? n(bt.stats.periodEquityPnl)
    : group.reduce((s, a) => s + n(stats[a.id]?.periodEquityPnl ?? stats[a.id]?.todayPnl), 0);
  const periodPct = btOk && Number.isFinite(bt.stats?.periodEquityPnlPct) ? bt.stats.periodEquityPnlPct : null;
  const pausedCount = group.filter((a) => a.paused).length;
  const on = group.some((a) => store.state.view === a.id);
  const name = BROKER_LABEL[key] || key;
  // Status rides next to the title now (was a bottom .pfoot row) — LIVE when
  // every sleeve is running, else an amber "N paused" chip.
  const status = pausedCount === 0
    ? `<span class="live"><span class="d"></span>LIVE</span>`
    : `<span class="chip" style="color:var(--warn)">${pausedCount} ${t("paused", "en pausa")}</span>`;
  return `
    <div class="pcard ${on ? "on" : ""} fade-up" data-broker="${esc(key)}" role="button" tabindex="0" title="${esc(name)}">
      <div class="pcol pcol-l">
        <span class="pname"><span class="pdot" style="background:${dotColor(key)}"></span><b>${esc(name)}</b>${status}</span>
        <span class="peq">${money(equity, 0)}</span>
        <span class="psub">${esc(periodLabel(store.state.period))} <b style="color:${pnlColor(periodPnl)}">${moneySigned(periodPnl)}</b>${periodPct == null ? "" : ` <span class="muted">${pctSigned(periodPct)}</span>`}</span>
      </div>
      <div class="pspark" data-spark="${esc(key)}_main" aria-hidden="true"></div>
      <div class="pcol pcol-r">
        <span class="broker">${group.length} ${t("sleeves", "sleeves")}</span>
        <span class="pall" style="color:${pnlColor(allPct)}">${pctSigned(allPct)}</span>
        <span class="muted pdet">${t("Details →", "Detalle →")}</span>
      </div>
    </div>`;
}

export function renderProfiles() {
  const s = store.state;
  const accounts = s.dashboard?.accounts || [];
  if (!accounts.length) return `<div class="pcard skel" style="height:72px"></div>`.repeat(2);
  const stats = statsById(s.profiles);
  const brokerAccts = (s.profiles || []).flatMap((p) => p.brokerAccounts || []);
  const groups = new Map();
  for (const a of accounts) {
    const k = brokerKey(a.broker);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const order = [...groups.keys()].sort((a, b) => (a === "alpaca" ? -1 : b === "alpaca" ? 1 : 0));
  return order.map((k) => brokerCard(k, groups.get(k), brokerAccts.find((a) => String(a.brokerId || "").includes(k)), stats)).join("");
}

function sparkPath(vals, W, H, pad) {
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1, N = vals.length;
  const X = (i) => pad + (i / (N - 1)) * (W - 2 * pad);
  const Y = (v) => pad + (1 - (v - min) / range) * (H - 2 * pad);
  let line = `M ${X(0).toFixed(1)} ${Y(vals[0]).toFixed(1)}`;
  for (let i = 1; i < N; i++) line += ` L ${X(i).toFixed(1)} ${Y(vals[i]).toFixed(1)}`;
  return { line, area: `${line} L ${X(N - 1).toFixed(1)} ${H - pad} L ${X(0).toFixed(1)} ${H - pad} Z` };
}

// Shared tooltip node (appended to body so position:fixed is viewport-relative,
// same as the big equity chart / candle modal).
let tipEl = null;
const tooltip = () => (tipEl || (tipEl = Object.assign(document.body.appendChild(document.createElement("div")), { className: "tip" })));

// Fills each broker card's centre gutter with that broker's equity trend — one
// small fetch of its *_main broker-truth series per card, following the global
// window (store.state.period). Colour follows the window's direction. Called
// after every render() (the #profiles innerHTML is replaced each time).
export async function loadProfileSparks() {
  const s = store.state;
  const days = s.period === 0 ? undefined : s.period;
  const range = s.period === 0 ? "all" : undefined;
  for (const box of document.querySelectorAll(".pspark[data-spark]")) {
    try {
      const rows = (await api.equityHistory({ account: box.dataset.spark, days, range }))
        .filter((r) => Number.isFinite(r.equity) && r.equity > 0)
        .map((r) => ({ v: r.equity, t: r.snapshot_time, rebased: !!r.rebased }));
      drawSpark(box, rows);
    } catch { box.innerHTML = ""; box.classList.remove("has-data"); }
  }
}

// Draws the sparkline + wires a hover crosshair/dot/tooltip (same interaction as
// equity.js — value + Δ% vs the window start + ET date/time at the cursor).
function drawSpark(box, rows) {
  if (rows.length < 2) {
    box.classList.remove("has-data");
    box.innerHTML = `<span class="spark-empty">${t("No history yet", "Sin historial aún")}</span>`;
    return;
  }
  const vals = rows.map((r) => r.v);
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1, N = vals.length;
  const up = vals[N - 1] >= vals[0], col = up ? "var(--up)" : "var(--down)";
  const W = 240, H = 48, pad = 3;
  const { line, area } = sparkPath(vals, W, H, pad);
  box.classList.add("has-data");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" fill="${up ? "var(--up-soft)" : "var(--down-soft)"}"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="spark-cur"></div><div class="spark-dot" style="background:${col}"></div>`;
  const cur = box.querySelector(".spark-cur"), dot = box.querySelector(".spark-dot"), tip = tooltip();
  const fmtT = (ts) => store.state.period === 1 ? etTime(ts) : etDate(ts);
  box.onpointermove = (e) => {
    const r = box.getBoundingClientRect(); if (!r.width) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const i = Math.round(frac * (N - 1)), v = vals[i];
    const xpx = (i / (N - 1)) * r.width, ypx = (1 - (v - min) / range) * r.height;
    cur.style.left = xpx + "px"; cur.style.opacity = "1";
    dot.style.left = xpx + "px"; dot.style.top = ypx + "px"; dot.style.opacity = "1";
    const dPct = vals[0] > 0 ? (v / vals[0] - 1) * 100 : 0;
    const dPctHtml = rows[0].rebased ? "" : ` <span style="color:${pnlColor(dPct)}">${pctSigned(dPct, 2)}</span>`;
    tip.innerHTML = `<b>${money(v, 0)}</b>${dPctHtml}<br><span class="tt">${esc(fmtT(rows[i].t))}</span>`;
    tip.style.opacity = "1";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(window.innerWidth - tw - 6, e.clientX - tw / 2)) + "px";
    let ty = e.clientY + 16; if (ty + th > window.innerHeight - 6) ty = e.clientY - th - 12;
    tip.style.top = ty + "px";
  };
  box.onpointerleave = () => { cur.style.opacity = "0"; dot.style.opacity = "0"; tip.style.opacity = "0"; };
}
