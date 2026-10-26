// ── botnow.js — the "Bot" tab: what each portfolio is doing right now, in
// sentences a non-programmer reads once, then the last actions as a dated list.
// Owner (2026-10-25): "Tengo que saber qué está haciendo el bot, esa es la
// finalidad del dashboard." Data: GET /api/bot/now (one object per portfolio +
// an events list). Every function that builds words is pure and exported so
// the copy is tested against a fixture of a real day; the only DOM touch is
// loadBotNow. Times render in the viewer's zone; New York is named next to a
// stock-market time because that is where the clock that matters lives.
import { t, isEs } from "../store.js";
import { api } from "../api.js";
import { money, pnlWhole, n, num } from "../fmt.js";
import { esc } from "../ui.js";

const NY = "America/New_York";
const locale = () => (isEs() ? "es" : "en-GB"); // en-GB: "Fri 23 Oct", 24h clock
const ts = (v) => (typeof v === "number" ? v : v ? Date.parse(v) : NaN);
const DAY = 86400000;

// ── words ───────────────────────────────────────────────────────────────────

/** "trailing_stop" → "trailing stop". ONE table for every reason code the
 *  events carry; unknown codes read as their words, never as a code. */
export function reasonWord(code) {
  if (!code) return "";
  const R = {
    trailing_stop: t("trailing stop", "stop dinámico"),
    stop_loss: t("stop-loss", "stop de pérdida"),
    stop: t("stop-loss", "stop de pérdida"),
    max_hold: t("5-day limit", "límite de 5 días"),
    time_stop: t("5-day limit", "límite de 5 días"),
    breakout_short_time_stop: t("5-day limit", "límite de 5 días"),
    regime: t("market conditions", "condiciones del mercado"),
    shadow: t("orders simulated", "órdenes simuladas"),
    slot_displaced: t("a stronger pick took its slot", "otro valor más fuerte ocupó su plaza"),
    signal_exit: t("signal faded", "la señal se apagó"),
    signal_entry: t("new signal", "señal nueva"),
    entry: t("new signal", "señal nueva"),
    rebalance: t("daily rebalance", "rebalanceo diario"),
    daily_rebalance: t("daily rebalance", "rebalanceo diario"),
    momentum_rebalance: t("daily rebalance", "rebalanceo diario"),
    drawdown_control: t("drawdown control", "control de caída"),
    soft_drawdown: t("drawdown control", "control de caída"),
    hard_drawdown: t("drawdown limit", "límite de caída"),
    loss_streak: t("several losses in a row", "varias pérdidas seguidas"),
    regime_off: t("market below its 200-day average", "mercado bajo su media de 200 días"),
    regime_on: t("market back above its 200-day average", "mercado de nuevo sobre su media de 200 días"),
    market_closed: t("market closed", "mercado cerrado"),
    maintenance: t("maintenance", "mantenimiento"),
    model_cutover: t("new model version", "nueva versión del modelo"),
    cutover: t("new model version", "nueva versión del modelo"),
    broker_sync: t("matched to the broker", "ajuste con el broker"),
    manual: t("manual", "manual"),
    no_signal: t("no signal", "sin señal"),
  };
  const key = String(code).toLowerCase();
  return R[key] || key.replace(/_/g, " ");
}

/** The portfolio's name as the reader knows it (API label; two words localized). */
export function portfolioName(label) {
  return String(label || "")
    .replace(/MeanRev/i, t("Mean Reversion", "Reversión a la media"))
    .replace(/Crypto/i, t("Crypto", "Cripto"));
}

const isCrypto = (p) => /binance/i.test(p.broker || "") || /crypto/i.test(p.id || "");

/** "stocks and ETFs" / "stocks" / "coins", singular-aware. */
export function assetWord(p, count) {
  const one = count === 1;
  if (isCrypto(p)) return t(one ? "coin" : "coins", one ? "criptomoneda" : "criptomonedas");
  if (p.engine === "meanrev") return t(one ? "stock" : "stocks", one ? "acción" : "acciones");
  return t(one ? "stock" : "stocks and ETFs", one ? "acción" : "acciones y ETFs");
}

function refName(ref) {
  const names = { SPY: "S&P 500", QQQ: "Nasdaq 100", IWM: "Russell 2000", BTC: "Bitcoin", "BTC/USD": "Bitcoin", ETH: "Ether", "ETH/USD": "Ether" };
  return names[ref] || String(ref || t("the market", "el mercado"));
}

/** 0.97 → "about 1× its capital"; 1.5 → "1.5× its capital". */
export function grossPhrase(x) {
  const v = n(x, NaN);
  if (!Number.isFinite(v)) return "";
  const whole = Math.abs(v - Math.round(v)) < 0.1;
  const times = whole ? `${t("about", "aproximadamente")} ${Math.round(v)}×` : `${num(v, 1)}×`;
  return t(`${times} its capital`, `${times} de su capital`);
}

const pctWord = (x) => { const v = Math.abs(n(x)); return num(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1) + "%"; };

// ── time in words ───────────────────────────────────────────────────────────

const dayKey = (ms, tz) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
const dayDiff = (ms, now, tz) => Math.round((Date.parse(dayKey(ms, tz)) - Date.parse(dayKey(now, tz))) / DAY);
const clock = (ms, tz) => new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });

/** "today" / "tomorrow" / "yesterday" / "Monday" / "3 Nov" — the day in words. */
export function dayWord(ms, { now = Date.now(), tz } = {}) {
  const d = dayDiff(ms, now, tz);
  if (d === 0) return t("today", "hoy");
  if (d === 1) return t("tomorrow", "mañana");
  if (d === -1) return t("yesterday", "ayer");
  if (Math.abs(d) < 7) return new Date(ms).toLocaleDateString(locale(), { weekday: "long", timeZone: tz });
  return new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: tz });
}

/** "Monday 15:35 (09:35 New York)" — the viewer's clock, the market's clock
 *  named when it differs. `market` = the exchange's zone, or null for crypto. */
export function whenPhrase(ms, { now = Date.now(), tz, market = null } = {}) {
  const at = ts(ms);
  if (!Number.isFinite(at)) return "";
  const day = dayWord(at, { now, tz });
  const time = clock(at, tz);
  const named = day !== t("today", "hoy") && day !== t("tomorrow", "mañana") && day !== t("yesterday", "ayer");
  let s = isEs() ? `${named ? "el " : ""}${day} a las ${time}` : `${day} ${time}`;
  if (market) {
    const mkt = clock(at, market);
    const zone = market === NY ? t("New York", "Nueva York") : market;
    s += mkt === time ? ` ${zone}` : ` (${mkt} ${zone})`;
  }
  return s;
}

/** "1 min ago" / "3 h ago" / "2 days ago" — relative to `now` (tests pass one). */
export function sinceWord(ms, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - ts(ms)) / 1000));
  if (sec < 60) return t("just now", "ahora mismo");
  const m = Math.round(sec / 60);
  if (m < 60) return t(`${m} min ago`, `hace ${m} min`);
  const h = Math.round(m / 60);
  if (h < 24) return t(`${h} h ago`, `hace ${h} h`);
  const d = Math.round(h / 24);
  return t(`${d} day${d === 1 ? "" : "s"} ago`, `hace ${d} día${d === 1 ? "" : "s"}`);
}

/** "on Friday" / "today" — a past decision's day, prepositioned for the sentence. */
function onDay(ms, opts) {
  const w = dayWord(ms, opts);
  const bare = w === t("today", "hoy") || w === t("yesterday", "ayer");
  return bare ? w : (isEs() ? `el ${w}` : `on ${w}`);
}

// ── one portfolio ───────────────────────────────────────────────────────────
// A compact card: name + status, 2–3 plain-text chips with the facts that
// matter, a "last decision … now … next decision" line, and at most ONE short
// sentence for blocked/waiting states.

const WARN_BLOCKS = ["soft_drawdown", "hard_drawdown", "loss_streak", "maintenance"];
const trimmed = (p) => p.exposureScale != null && n(p.exposureScale, 1) < 0.995;
/** 1.5 → "1.5×", 1.0 → "1×". */
const times = (x) => `${num(n(x), Math.abs(n(x) - Math.round(n(x))) < 0.05 ? 0 : 1)}×`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The status word and its dot colour. */
export function statusOf(p) {
  switch (p.state) {
    case "error": return { word: t("Problem", "Problema"), color: "var(--down)" };
    case "paused": return { word: t("Paused", "En pausa"), color: "var(--warn)" };
    case "waiting_first_pass": return { word: t("Waiting for its first decision", "Esperando su primera decisión"), color: "var(--accent)" };
    case "flat": return { word: t("Out of the market", "Fuera del mercado"), color: "var(--muted)" };
  }
  if (trimmed(p)) return { word: t("Invested, trading smaller", "Invertido, con menos tamaño"), color: "var(--warn)" };
  const warn = WARN_BLOCKS.includes(p.blocked?.reason);
  const word = p.state === "partly_invested" ? t("Partly invested", "Parcialmente invertido") : t("Invested", "Invertido");
  return { word, color: warn ? "var(--warn)" : "var(--up)" };
}

function blockedSentence(p, o) {
  const b = p.blocked;
  if (!b) return "";
  const until = b.until ? whenPhrase(b.until, { ...o, market: isCrypto(p) ? null : NY }) : "";
  switch (b.reason) {
    case "soft_drawdown":
      return until ? t(`No new buys until ${until}.`, `Sin compras nuevas hasta ${until}.`) : t("No new buys for now.", "Sin compras nuevas por ahora.");
    case "hard_drawdown":
      return t(`Trading paused${until ? ` until ${until}` : ""}: it fell too far from its peak.`, `Operativa en pausa${until ? ` hasta ${until}` : ""}: cayó demasiado desde su máximo.`);
    case "loss_streak":
      return t(`No new buys${until ? ` until ${until}` : ""}: several losses in a row.`, `Sin compras nuevas${until ? ` hasta ${until}` : ""}: varias pérdidas seguidas.`);
    case "maintenance":
      return t(`Paused for maintenance${until ? ` until ${until}` : ""}.`, `En pausa por mantenimiento${until ? ` hasta ${until}` : ""}.`);
    case "shadow":
      return t("Orders are simulated; none reach the broker.", "Las órdenes se simulan; ninguna llega al broker.");
    default:
      return ""; // market_closed, no_signal and unknown gates are said by chips / the time line
  }
}

/** "S&P 500 +5% vs its 200-day average". */
function regimeChip(p) {
  const r = p.regime;
  if (!r || r.distancePct == null) return "";
  const sign = n(r.distancePct) < 0 ? "−" : "+";
  const d = `${sign}${pctWord(r.distancePct)}`;
  return t(`${refName(r.ref)} ${d} vs its 200-day average`, `${refName(r.ref)} ${d} frente a su media de 200 días`);
}

/** The 2–3 key facts of a portfolio as plain strings (the reason, for paused and
 *  flat states). Pure. */
export function chipsOf(p) {
  const count = n(p.positions);
  const eq = p.investedUsd != null ? money(p.investedUsd, 0) : p.equityUsd != null ? money(p.equityUsd, 0) : "";
  const held = count > 0
    ? t(`Holds ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""}`, `Mantiene ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""}`)
    : "";
  const regime = regimeChip(p);
  switch (p.state) {
    case "error":
      return [];
    case "paused":
      return [p.blocked?.reason ? cap(reasonWord(p.blocked.reason)) : "", held].filter(Boolean);
    case "waiting_first_pass":
      return [held, regime].filter(Boolean);
    case "flat": {
      const uni = p.lastDecision?.universe;
      const uniW = uni ? `${uni} ${assetWord(p, uni)}` : null;
      const noSignal = p.blocked?.reason === "no_signal" || (p.lastDecision && n(p.lastDecision.signalsLong, -1) === 0);
      const chips = [regime];
      if (!(p.regime && !p.regime.riskOn)) {
        if (noSignal) chips.push(p.engine === "meanrev"
          ? (uniW ? t(`None of ${uniW} dropped enough to buy`, `Ninguna de ${uniW} cayó lo suficiente para comprar`) : t("Nothing dropped enough to buy", "Nada cayó lo suficiente para comprar"))
          : (uniW ? t(`None of ${uniW} is trending up`, `Ninguna de ${uniW} está en tendencia alcista`) : t("Nothing is trending up", "Nada está en tendencia alcista")));
        else if (p.blocked && p.blocked.reason !== "market_closed") chips.push(cap(reasonWord(p.blocked.reason)));
      }
      const out = chips.filter(Boolean);
      return out.length ? out : [t("Holds no positions", "Sin posiciones")];
    }
    default: { // invested / partly_invested
      const chips = [eq ? t(`Invested ${eq}`, `Invertido ${eq}`) : `${count} ${assetWord(p, count)}`];
      if (p.maxGrossX != null && n(p.maxGrossX) > 1.05 && p.grossX != null) {
        chips.push(t(`Leverage ${times(p.grossX)} of ${times(p.maxGrossX)}`, `Apalancamiento ${times(p.grossX)} de ${times(p.maxGrossX)}`));
      }
      chips.push(regime);
      if (trimmed(p)) {
        const scale = Math.round(n(p.exposureScale) * 100);
        chips.push(t(`${scale}% of normal size`, `${scale}% del tamaño normal`));
        if (p.drawdownPct != null) chips.push(t(`${pctWord(p.drawdownPct)} below its peak`, `${pctWord(p.drawdownPct)} bajo su máximo`));
      }
      const out = chips.filter(Boolean).slice(0, 3);
      if (out.length < 2 && eq && count > 0) out.push(`${count} ${assetWord(p, count)}`);
      return out;
    }
  }
}

/** The ONE short sentence under the time line: only for blocked / waiting /
 *  failed states ("" otherwise). Pure. */
export function noteOf(p, o = {}) {
  switch (p.state) {
    case "error":
      return p.blocked?.detail || t("Something failed and it is not trading; see the Activity tab.", "Algo falló y no está operando; mira la pestaña Actividad.");
    case "paused":
      return blockedSentence(p, o) || t("Paused; it opens no new positions.", "En pausa; no abre posiciones nuevas.");
    case "waiting_first_pass":
      return t("A new model version goes live at its next decision.", "Una nueva versión del modelo entra en vigor en su próxima decisión.");
    default:
      return blockedSentence(p, o);
  }
}

/** "in 28 min" / "in 3 h" — a coming moment, relative to `now`. */
export function untilWord(ms, now = Date.now()) {
  const sec = Math.round((ts(ms) - now) / 1000);
  if (sec < 60) return t("in under a minute", "en menos de un minuto");
  const m = Math.round(sec / 60);
  if (m < 60) return t(`in ${m} min`, `en ${m} min`);
  const h = Math.round(m / 60);
  return t(`in ${h} h`, `en ${h} h`);
}

const SOON = 3 * 3600e3;
/** A decision moment: relative when it is close, the viewer's clock (+ New York
 *  for stock sleeves) when it is not. */
function stamp(ms, p, o, past) {
  const at = ts(ms), now = o.now ?? Date.now();
  if (past && now - at < SOON) return sinceWord(at, now);
  if (!past && at - now < SOON) return untilWord(at, now);
  return whenPhrase(at, { ...o, market: isCrypto(p) ? null : NY });
}

/** `last decision ●──── now ────○ next decision`, each end labelled with its
 *  time. "now" sits where it falls between the two. Pure. */
export function timeLine(p, o = {}) {
  const now = o.now ?? Date.now();
  const last = ts(p.lastDecision?.at), next = ts(p.nextDecisionAt);
  const hasLast = Number.isFinite(last), hasNext = Number.isFinite(next);
  if (!hasLast && !hasNext) return "";
  const kl = t("Last decision", "Última decisión"), kn = t("Next decision", "Próxima decisión");
  const label = (k, v) => `<span><span class="bn-tl-k">${esc(k)}</span> ${esc(v)}</span>`;
  if (!hasLast || !hasNext) {
    return `<div class="bn-tl-solo">${hasNext ? label(kn, stamp(next, p, { ...o, now }, false)) : label(kl, stamp(last, p, { ...o, now }, true))}</div>`;
  }
  const f = next > last ? Math.min(0.92, Math.max(0.08, (now - last) / (next - last))) : 0.5;
  return `<div class="bn-tl">
    <div class="bn-tl-track" aria-hidden="true"><i class="bn-tl-dot"></i><i class="bn-tl-bar" style="flex-grow:${f.toFixed(3)}"></i><span class="bn-tl-now">${t("now", "ahora")}</span><i class="bn-tl-bar" style="flex-grow:${(1 - f).toFixed(3)}"></i><i class="bn-tl-dot bn-tl-hollow"></i></div>
    <div class="bn-tl-labels">${label(kl, stamp(last, p, { ...o, now }, true))}${label(kn, stamp(next, p, { ...o, now }, false))}</div>
  </div>`;
}

function portfolioBlock(p, o) {
  const st = statusOf(p);
  const chips = chipsOf(p).map((c) => `<span class="bn-chip">${esc(c)}</span>`).join("");
  const note = noteOf(p, o);
  return `<div class="bn-row">
    <div class="bn-head"><span class="bn-name">${esc(portfolioName(p.label || p.id))}</span><span class="bn-word" style="color:${st.color}"><span class="bn-dot" style="background:${st.color}"></span>${esc(st.word)}</span></div>
    ${chips ? `<div class="bn-chips">${chips}</div>` : ""}
    ${timeLine(p, o)}
    ${note ? `<p class="bn-text">${esc(note)}</p>` : ""}
  </div>`;
}

// ── events ──────────────────────────────────────────────────────────────────

/** One event as a sentence (no time; the row shows it). `portfolios` maps id →
 *  the /api/bot/now portfolio (for its label and asset words). Pure. */
const LIMIT_REASON = /^(max_hold|time_stop|breakout_short_time_stop)$/i;
/** A close forced by the owner's 5-day maximum hold, whatever engine wrote it. */
const isLimitClose = (e) => ["close", "sell", "stop"].includes(e.kind) && LIMIT_REASON.test(e.reason || "");

/** `opts.bare` drops the portfolio name (a line inside an expanded pass);
 *  `opts.rebought` marks a 5-day close whose symbol was bought again in the pass. */
export function eventSentence(ev, portfolios = {}, opts = {}) {
  const known = portfolios[ev.portfolioId];
  const who = opts.bare ? "" : portfolioName(known?.label || ev.portfolioId || t("The bot", "El bot"));
  const p = known || { broker: /crypto|binance/i.test(ev.portfolioId || "") ? "binance" : "alpaca", id: ev.portfolioId || "" };
  const qty = n(ev.qty);
  const usd = ev.usd != null ? ` (${money(ev.usd, 0)})` : "";
  const pnl = ev.pnlUsd != null ? `, ${pnlWhole(ev.pnlUsd)}` : "";
  const what = ev.symbol ? esc(ev.symbol) : qty > 0 ? `${qty} ${t(qty === 1 ? "position" : "positions", qty === 1 ? "posición" : "posiciones")}` : t("its positions", "sus posiciones");
  const bought = ev.symbol ? esc(ev.symbol) : qty > 0 ? `${qty} ${assetWord(p, qty)}` : t("positions", "posiciones");
  const limit = isLimitClose(ev);
  let body;
  switch (limit ? "limit" : ev.kind) {
    case "limit": {
      const loss = ev.pnlUsd != null ? ` (${pnlWhole(ev.pnlUsd)})` : "";
      body = t(`${who} closed ${what} at the 5-day limit${loss}${opts.rebought ? " and re-bought it" : ""}`,
        `${who} cerró ${what} por el límite de 5 días${loss}${opts.rebought ? " y lo volvió a comprar" : ""}`);
      break;
    }
    case "buy": body = t(`${who} bought ${bought}${usd}`, `${who} compró ${bought}${usd}`); break;
    case "sell":
    case "close": body = t(`${who} sold ${what}${pnl || usd}`, `${who} vendió ${what}${pnl || usd}`); break;
    case "stop": body = t(`${who} was stopped out of ${what}${pnl}`, `${who} salió de ${what} por stop${pnl}`); break;
    case "resize": {
      // usd is signed: negative = the position was cut (sold part of it).
      const amt = ev.usd != null ? ` (${money(Math.abs(n(ev.usd)), 0)})` : "";
      body = n(ev.usd) > 0
        ? t(`${who} added to ${what}${amt}`, `${who} amplió ${what}${amt}`)
        : t(`${who} trimmed ${what}${amt}`, `${who} recortó ${what}${amt}`);
      break;
    }
    case "rebalance": {
      const b = Number(ev.buys) || 0, sl = Number(ev.sells) || 0;
      const what = b || sl
        ? t(`bought ${b} and sold ${sl}`, `compró ${b} y vendió ${sl}`)
        : t(`rebalanced${qty > 0 ? ` ${qty} positions` : ""}`, `rebalanceó${qty > 0 ? ` ${qty} posiciones` : ""}`);
      body = `${who} ${what}${usd}`; break;
    }
    case "pause": body = t(`${who} paused new buys`, `${who} pausó las compras nuevas`); break;
    case "resume": body = t(`${who} resumed buying`, `${who} volvió a comprar`); break;
    case "cutover": body = t(`${who} switched to a new model version`, `${who} cambió a una nueva versión del modelo`); break;
    case "treasury": body = t(`${who} moved cash${usd}`, `${who} movió efectivo${usd}`); break;
    case "error": body = t(`Problem in ${who}`, `Problema en ${who}`); break;
    default: body = `${who} ${esc(String(ev.kind || "").replace(/_/g, " "))}${what === t("its positions", "sus posiciones") ? "" : ` ${what}`}${usd}`;
  }
  const reason = ev.reason && !limit ? ` <span class="bn-why">— ${esc(reasonWord(ev.reason))}</span>` : "";
  const detail = ev.kind === "error" && ev.detail ? ` <span class="muted">${esc(ev.detail)}</span>` : "";
  return `${body.trim()}${reason}${detail}`;
}

// ── passes: one line per portfolio decision ─────────────────────────────────

const PASS_KINDS = new Set(["buy", "sell", "close", "stop", "resize", "rebalance"]);

/** Events (newest first, as groupEventsByDay returns them) → rows. Events of the
 *  same portfolio less than a minute apart are one pass: [{ portfolioId, events }]
 *  with `events` still newest first. Pure. */
export function clusterPasses(items) {
  const rows = [], open = new Map();
  for (const e of items || []) {
    const clusterable = !!e.portfolioId && PASS_KINDS.has(e.kind);
    const row = clusterable ? open.get(e.portfolioId) : null;
    if (row && ts(row.events[row.events.length - 1].at) - ts(e.at) <= 60_000) { row.events.push(e); continue; }
    const fresh = { portfolioId: e.portfolioId, events: [e] };
    rows.push(fresh);
    if (clusterable) open.set(e.portfolioId, fresh);
  }
  return rows;
}

const posWord = (c) => t(c === 1 ? "position" : "positions", c === 1 ? "posición" : "posiciones");

/** One pass as a sentence plus its per-symbol lines: { text, lines } (HTML). The
 *  5-day closes and the buys of the same symbol read as "closed … and re-bought
 *  …"; a rebalance event brings the pass's totals and its renewal symbols. Pure. */
export function passSummary(events, portfolios = {}) {
  const first = events[0];
  const known = portfolios[first.portfolioId];
  const who = esc(portfolioName(known?.label || first.portfolioId || t("The bot", "El bot")));
  const p = known || { broker: /crypto|binance/i.test(first.portfolioId || "") ? "binance" : "alpaca", id: first.portfolioId || "" };
  const rb = events.find((e) => e.kind === "rebalance");
  const limits = events.filter(isLimitClose);
  const buys = events.filter((e) => e.kind === "buy");
  const rebuy = new Set([...(rb?.rebought || []), ...buys.map((e) => e.symbol).filter((s) => s && limits.some((l) => l.symbol === s))]);
  const closed = Math.max(limits.length, rebuy.size);
  const parts = [];

  if (closed > 0) {
    const single = closed === 1 && limits[0]?.symbol ? esc(limits[0].symbol) : "";
    const what = single || `${closed} ${posWord(closed)}`;
    const r = rebuy.size;
    if (!limits.length) {
      parts.push(t(`closed and re-bought ${what} at the 5-day limit`, `cerró y volvió a comprar ${what} por el límite de 5 días`));
    } else {
      const loss = limits.some((e) => e.pnlUsd != null) ? ` (${pnlWhole(limits.reduce((s, e) => s + n(e.pnlUsd), 0))})` : "";
      const again = r === 0 ? ""
        : r < closed ? t(` and re-bought ${r} of them`, ` y volvió a comprar ${r} de ellas`)
        : closed === 1 ? t(" and re-bought it", single ? " y lo volvió a comprar" : " y la volvió a comprar")
        : t(" and re-bought them", " y las volvió a comprar");
      parts.push(t(`closed ${what} at the 5-day limit${loss}${again}`, `cerró ${what} por el límite de 5 días${loss}${again}`));
    }
  }

  const sold = events.filter((e) => (e.kind === "sell" || e.kind === "close") && !isLimitClose(e));
  const soldCount = sold.length + (rb ? Math.max(0, n(rb.sells) - closed) : 0);
  if (soldCount > 0) {
    const loss = sold.some((e) => e.pnlUsd != null) ? ` (${pnlWhole(sold.reduce((s, e) => s + n(e.pnlUsd), 0))})` : "";
    const what = soldCount === 1 && sold[0]?.symbol ? esc(sold[0].symbol) : `${soldCount} ${posWord(soldCount)}`;
    parts.push(t(`sold ${what}${loss}`, `vendió ${what}${loss}`));
  }
  const stops = events.filter((e) => e.kind === "stop" && !isLimitClose(e));
  if (stops.length) {
    const loss = stops.some((e) => e.pnlUsd != null) ? ` (${pnlWhole(stops.reduce((s, e) => s + n(e.pnlUsd), 0))})` : "";
    const what = stops.length === 1 && stops[0].symbol ? esc(stops[0].symbol) : `${stops.length} ${posWord(stops.length)}`;
    parts.push(t(`stopped out of ${what}${loss}`, `salió de ${what} por stop${loss}`));
  }

  const fresh = buys.filter((e) => !rebuy.has(e.symbol));
  const newCount = fresh.length + (rb ? Math.max(0, n(rb.buys) - (rb.rebought?.length || 0)) : 0);
  if (newCount > 0) {
    let usd = fresh.reduce((s, e) => s + n(e.usd), 0);
    usd = rb ? (rb.newBuyUsd != null ? usd + rb.newBuyUsd : null) : usd;
    const amt = usd != null && usd > 0 ? ` (${money(usd, 0)})` : "";
    const one = newCount === 1 && !rb && fresh[0]?.symbol ? esc(fresh[0].symbol) : "";
    parts.push(closed > 0
      ? t(`${newCount} new buy${newCount === 1 ? "" : "s"}${amt}`, `${newCount} compra${newCount === 1 ? "" : "s"} nueva${newCount === 1 ? "" : "s"}${amt}`)
      : t(`bought ${one || `${newCount} ${assetWord(p, newCount)}`}${amt}`, `compró ${one || `${newCount} ${assetWord(p, newCount)}`}${amt}`));
  }
  const resizes = events.filter((e) => e.kind === "resize");
  if (resizes.length) parts.push(t(`resized ${resizes.length} ${posWord(resizes.length)}`, `ajustó ${resizes.length} ${posWord(resizes.length)}`));

  const lines = [];
  for (const e of events) {
    lines.push(eventSentence(e, portfolios, { bare: true, rebought: isLimitClose(e) && rebuy.has(e.symbol) }));
    if (e.kind === "rebalance" && e.rebought?.length) lines.push(t(`re-bought ${e.rebought.map(esc).join(", ")}`, `volvió a comprar ${e.rebought.map(esc).join(", ")}`));
  }
  return { text: parts.length ? `${who}: ${parts.join(", ")}` : eventSentence(first, portfolios), lines };
}

function eventRow(row, names) {
  const e0 = row.events[0], time = row.events[row.events.length - 1].time;
  const pass = row.events.length > 1 || (e0.kind === "rebalance" && e0.rebought?.length);
  if (!pass) return `<div class="bn-ev"><span class="bn-time">${esc(time)}</span><span>${eventSentence(e0, names)}</span></div>`;
  const s = passSummary(row.events, names);
  return `<div class="bn-ev"><span class="bn-time">${esc(time)}</span><details class="bn-pass"><summary>${s.text}</summary><ul class="bn-lines">${s.lines.map((l) => `<li>${l}</li>`).join("")}</ul></details></div>`;
}

/** Events newest first, grouped by the viewer's day: [{ label, items }]. Pure. */
export function groupEventsByDay(events, { now = Date.now(), tz } = {}) {
  const sorted = (events || []).filter((e) => Number.isFinite(ts(e.at))).slice().sort((a, b) => ts(b.at) - ts(a.at));
  const groups = [];
  for (const e of sorted) {
    const at = ts(e.at), key = dayKey(at, tz);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      const d = dayDiff(at, now, tz);
      const label = d === 0 ? t("Today", "Hoy") : d === -1 ? t("Yesterday", "Ayer")
        : new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: tz });
      g = { key, label, items: [] };
      groups.push(g);
    }
    g.items.push({ ...e, time: clock(at, tz) });
  }
  return groups;
}

// ── the tab ─────────────────────────────────────────────────────────────────

/** The whole tab body. `o.now`/`o.tz` exist for tests; the browser uses its own. */
export function renderBotNow(data, o = {}) {
  if (!data || !Array.isArray(data.portfolios)) return `<div class="empty">${t("The bot has not reported yet.", "El bot aún no ha informado.")}</div>`;
  const names = {};
  for (const p of data.portfolios) names[p.id] = p;
  const blocks = data.portfolios.length
    ? data.portfolios.map((p) => portfolioBlock(p, o)).join("")
    : `<div class="empty">${t("No portfolios are running.", "No hay portafolios en marcha.")}</div>`;
  const groups = groupEventsByDay(data.events, o);
  const events = groups.length
    ? groups.map((g) => `<div class="bn-day">${esc(g.label)}</div>${clusterPasses(g.items).map((row) => eventRow(row, names)).join("")}`).join("")
    : `<div class="muted" style="font-size:var(--t-xs)">${t("No actions in the last few days.", "Sin acciones en los últimos días.")}</div>`;
  return `<div class="bn-list">${blocks}</div>
    <div class="an-h" style="margin-top:var(--s4)">${t("Recent actions", "Acciones recientes")}</div>
    <div class="bn-events">${events}</div>`;
}

/** Fetch + paint into the analytics card body. `?botfixture` in the URL paints
 *  the test fixture instead (screenshots without a backend). */
export async function loadBotNow(body) {
  if (!body) return;
  const useFixture = typeof location !== "undefined" && /[?&]botfixture\b/.test(location.search || "");
  if (useFixture) {
    const { BOT_NOW_FIXTURE, FIXTURE_NOW } = await import("./botnow.fixture.js");
    body.innerHTML = renderBotNow(BOT_NOW_FIXTURE, { now: FIXTURE_NOW });
    return;
  }
  body.innerHTML = renderBotNow(await api.botNow());
}
