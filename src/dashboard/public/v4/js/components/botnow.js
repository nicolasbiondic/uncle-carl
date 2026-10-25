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
    time_stop: t("held too long", "tiempo máximo en cartera"),
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

const WARN_BLOCKS = ["soft_drawdown", "hard_drawdown", "loss_streak", "maintenance"];
const trimmed = (p) => p.exposureScale != null && n(p.exposureScale, 1) < 0.995;

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
    case "market_closed":
      return t("The market is closed.", "El mercado está cerrado.");
    case "no_signal":
      return ""; // said by the "none of its N coins…" sentence
    default:
      return "";
  }
}

function regimeSentence(p) {
  const r = p.regime;
  if (!r || r.distancePct == null) return "";
  const ref = refName(r.ref), d = pctWord(r.distancePct);
  if (r.riskOn) return t(`The ${ref} is ${d} above its 200-day average, so it stays invested.`, `El ${ref} está un ${d} por encima de su media de 200 días, así que sigue invertido.`);
  return t(`The ${ref} is ${d} below its 200-day average, so it stays in cash.`, `El ${ref} está un ${d} por debajo de su media de 200 días, así que se queda en efectivo.`);
}

function lastDecisionSentence(p, o) {
  const d = p.lastDecision;
  if (!d || !Number.isFinite(ts(d.at))) return "";
  const orders = n(d.orders), rejected = n(d.rejected);
  const ordersW = orders === 0 ? t("no orders", "sin órdenes") : orders === 1 ? t("1 order", "1 orden") : t(`${orders} orders`, `${orders} órdenes`);
  const rejW = orders === 0 ? "" : rejected === 0 ? t(", none rejected", ", ninguna rechazada") : t(`, ${rejected} rejected`, `, ${rejected} rechazada${rejected === 1 ? "" : "s"}`);
  return t(`Last decision ${onDay(ts(d.at), o)}: ${ordersW}${rejW}.`, `Última decisión ${onDay(ts(d.at), o)}: ${ordersW}${rejW}.`);
}

function nextSentence(p, o) {
  const market = isCrypto(p) ? null : NY;
  if (p.cadence?.kind === "hourly") {
    const last = p.lastDecision?.at;
    const lastW = Number.isFinite(ts(last)) ? t(` (last check ${sinceWord(last, o.now)})`, ` (última revisión ${sinceWord(last, o.now)})`) : "";
    return t(`It checks every hour${lastW}.`, `Revisa cada hora${lastW}.`);
  }
  if (!Number.isFinite(ts(p.nextDecisionAt))) {
    return p.cadence?.at ? t(`It decides once a day at ${p.cadence.at}.`, `Decide una vez al día a las ${p.cadence.at}.`) : "";
  }
  const when = whenPhrase(p.nextDecisionAt, { ...o, market });
  const lev = p.maxGrossX != null && n(p.maxGrossX) > 1.05
    ? t(`; it can use up to ${num(p.maxGrossX, 1)}× leverage`, `; puede usar hasta ${num(p.maxGrossX, 1)}× de apalancamiento`)
    : "";
  return t(`Next decision ${when}${lev}.`, `Próxima decisión ${when}${lev}.`);
}

/** The sentences for one portfolio, in order. Pure. */
export function describePortfolio(p, o = {}) {
  const s = [];
  const count = n(p.positions);
  const eq = p.investedUsd != null ? money(p.investedUsd, 0) : p.equityUsd != null ? money(p.equityUsd, 0) : "";
  switch (p.state) {
    case "error":
      s.push(p.blocked?.detail || t("Something failed and it is not trading; see the Activity tab.", "Algo falló y no está operando; mira la pestaña Actividad."));
      break;
    case "paused":
      s.push(blockedSentence(p, o) || t("Paused; it holds no new positions.", "En pausa; no abre posiciones nuevas."));
      if (count > 0) s.push(t(`It still holds ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""}.`, `Aún mantiene ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""}.`));
      break;
    case "waiting_first_pass": {
      s.push(t("A new model version goes live at its next decision.", "Una nueva versión del modelo entra en vigor en su próxima decisión."));
      if (count > 0) s.push(t(`It holds ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""} from the previous version.`, `Mantiene ${count} ${assetWord(p, count)}${eq ? ` (${eq})` : ""} de la versión anterior.`));
      s.push(regimeSentence(p), nextSentence(p, o));
      break;
    }
    case "flat": {
      const uni = p.lastDecision?.universe ?? p.blocked?.universe;
      const uniW = uni ? `${uni} ${assetWord(p, uni)}` : assetWord(p, 2);
      const noSignal = p.blocked?.reason === "no_signal" || (p.lastDecision && n(p.lastDecision.signalsLong, -1) === 0);
      if (p.regime && !p.regime.riskOn) s.push(regimeSentence(p));
      else if (noSignal) s.push(p.engine === "meanrev"
        ? t(`None of its ${uniW} has dropped enough to buy.`, `Ninguna de sus ${uniW} ha caído lo suficiente para comprar.`)
        : t(`None of its ${uniW} is trending up.`, `Ninguna de sus ${uniW} está en tendencia alcista.`));
      else s.push(blockedSentence(p, o) || t("It holds no positions.", "No tiene posiciones."));
      if (p.blocked && p.blocked.reason !== "no_signal") s.push(blockedSentence(p, o));
      s.push(nextSentence(p, o));
      break;
    }
    default: { // invested / partly_invested
      if (trimmed(p)) {
        const scale = Math.round(n(p.exposureScale) * 100);
        const dd = p.drawdownPct != null ? pctWord(p.drawdownPct) : null;
        s.push(t(
          `Holding ${count} ${assetWord(p, count)} at ${scale}% of normal size${eq ? ` (${eq})` : ""}${dd ? `: it is ${dd} below its peak, so it trades smaller` : ""}.`,
          `Mantiene ${count} ${assetWord(p, count)} al ${scale}% del tamaño normal${eq ? ` (${eq})` : ""}${dd ? `: está un ${dd} por debajo de su máximo, así que opera con menos tamaño` : ""}.`));
      } else {
        const g = grossPhrase(p.grossX);
        const paren = [eq, g].filter(Boolean).join(", ");
        s.push(t(`Invested in ${count} ${assetWord(p, count)}${paren ? ` (${paren})` : ""}.`, `Invertido en ${count} ${assetWord(p, count)}${paren ? ` (${paren})` : ""}.`));
      }
      s.push(regimeSentence(p));
      if (p.cadence?.kind !== "hourly") s.push(lastDecisionSentence(p, o));
      s.push(blockedSentence(p, o), nextSentence(p, o));
    }
  }
  return s.filter(Boolean);
}

function portfolioBlock(p, o) {
  const st = statusOf(p);
  return `<div class="bn-row">
    <div class="bn-head"><span class="bn-name">${esc(portfolioName(p.label || p.id))}</span><span class="bn-word" style="color:${st.color}"><span class="bn-dot" style="background:${st.color}"></span>${esc(st.word)}</span></div>
    <p class="bn-text">${describePortfolio(p, o).map(esc).join(" ")}</p>
  </div>`;
}

// ── events ──────────────────────────────────────────────────────────────────

/** One event as a sentence (no time; the row shows it). `portfolios` maps id →
 *  the /api/bot/now portfolio (for its label and asset words). Pure. */
export function eventSentence(ev, portfolios = {}) {
  const known = portfolios[ev.portfolioId];
  const who = portfolioName(known?.label || ev.portfolioId || t("The bot", "El bot"));
  const p = known || { broker: /crypto|binance/i.test(ev.portfolioId || "") ? "binance" : "alpaca", id: ev.portfolioId || "" };
  const qty = n(ev.qty);
  const usd = ev.usd != null ? ` (${money(ev.usd, 0)})` : "";
  const pnl = ev.pnlUsd != null ? `, ${pnlWhole(ev.pnlUsd)}` : "";
  const what = ev.symbol ? esc(ev.symbol) : qty > 0 ? `${qty} ${t(qty === 1 ? "position" : "positions", qty === 1 ? "posición" : "posiciones")}` : t("its positions", "sus posiciones");
  const bought = ev.symbol ? esc(ev.symbol) : qty > 0 ? `${qty} ${assetWord(p, qty)}` : t("positions", "posiciones");
  let body;
  switch (ev.kind) {
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
  const reason = ev.reason ? ` <span class="bn-why">— ${esc(reasonWord(ev.reason))}</span>` : "";
  const detail = ev.kind === "error" && ev.detail ? ` <span class="muted">${esc(ev.detail)}</span>` : "";
  return `${body}${reason}${detail}`;
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
    ? groups.map((g) => `<div class="bn-day">${esc(g.label)}</div>${g.items.map((e) => `<div class="bn-ev"><span class="bn-time">${esc(e.time)}</span><span>${eventSentence(e, names)}</span></div>`).join("")}`).join("")
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
