import { api, setCsrf } from "./api.js";
import { store, t } from "./store.js";
import { byId, on, esc } from "./ui.js";
import { renderHeader, renderActions, tickClock } from "./components/header.js";
import { renderKpis, kpiValues } from "./components/kpis.js";
import { openPnlBreakdown } from "./components/pnl-breakdown.js";
import { renderProfiles, loadProfileSparks } from "./components/profiles.js";
import { renderPositions } from "./components/positions.js";
import { renderTrades } from "./components/trades.js";
import { renderAnalyticsShell, loadTab, setMonthlyReturnsProfile } from "./components/analytics.js";
import { renderNewsBar, loadNews, toggleNews } from "./components/news.js";
import { loadFng } from "./components/fng.js";
import { connectWS } from "./ws.js";
import { bindPalette } from "./components/palette.js";
import { openCandles } from "./components/candle.js";
import { openBrokerModal } from "./components/broker-modal.js";
import { openSettings } from "./components/settings.js";
import { openAccounts, oauthResultFromSearch } from "./components/accounts.js";
import { openPortfolios } from "./components/portfolios.js";
import { num, n } from "./fmt.js";

let opsTab = "positions";
let tradesCache = [];
let prevKpi = {};
let refreshT = null;
const debouncedRefresh = () => { clearTimeout(refreshT); refreshT = setTimeout(async () => { await refresh(); render(); }, 1500); };

function applyTheme() { document.documentElement.dataset.theme = store.state.theme; }

function renderOps() {
  const inner = opsTab === "positions" ? renderPositions(store.state, tradesCache) : renderTrades(tradesCache);
  const tab = (id, label) => `<button class="tab ${opsTab === id ? "on" : ""}" data-opstab="${id}">${label}</button>`;
  return `<div class="card" id="opsCard">
    <div class="tabs">${tab("positions", t("Positions", "Posiciones"))}${tab("trades", t("Trades", "Trades"))}</div>
    <div class="cardbody" id="opsBody">${inner}</div></div>`;
}

// Bottom price ticker — Binance spot public API, client-side (the proven v3
// pattern; CSP already allows api.binance.com). The bot's own marketData was
// the wrong source: it carries price=0 for every symbol without a live feed
// (stocks after hours), which rendered "$0.0000 0.00%" rows.
const TICKER_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
let tickerRows = [];
async function loadTicker() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbols=" + JSON.stringify(TICKER_SYMBOLS));
    const arr = await res.json();
    if (Array.isArray(arr)) tickerRows = arr
      .map((x) => ({ sym: x.symbol.replace("USDT", ""), price: +x.lastPrice, chg: +x.priceChangePercent }))
      .filter((x) => x.price > 0);
  } catch {}
  renderTicker();
}
function renderTicker() {
  if (!tickerRows.length) { byId("ticker").hidden = true; return; }
  const one = tickerRows.map((x) =>
    `<span class="t">${esc(x.sym)} <b>$${num(x.price, x.price < 10 ? 4 : 2)}</b> <span style="color:${x.chg >= 0 ? "var(--up)" : "var(--down)"}">${x.chg >= 0 ? "▲" : "▼"} ${num(Math.abs(x.chg), 2)}%</span></span>`
  ).join("");
  // Two identical flex halves → translateX(-50%) lands exactly on the seam
  // (see .ticker-half in app.css). Second copy is decorative for a11y.
  byId("tickerIn").innerHTML = `<div class="ticker-half">${one}</div><div class="ticker-half" aria-hidden="true">${one}</div>`;
  byId("ticker").hidden = false;
}

/** flash the equity / today-P&L KPI cells when the value changes ("live" feel) */
function flashKpis() {
  const k = kpiValues(store.state);
  const cells = byId("kpis")?.querySelectorAll(".kpi");
  if (cells) {
    if (prevKpi.equity != null && k.equity !== prevKpi.equity) cells[0]?.classList.add(k.equity >= prevKpi.equity ? "flash-up" : "flash-down");
    if (prevKpi.periodPnl != null && k.periodPnl !== prevKpi.periodPnl) cells[1]?.classList.add(k.periodPnl >= prevKpi.periodPnl ? "flash-up" : "flash-down");
  }
  prevKpi = { equity: k.equity, periodPnl: k.periodPnl };
}

function render() {
  applyTheme();
  byId("hdr").innerHTML = renderHeader();
  byId("hdrActions").innerHTML = renderActions();
  byId("kpis").innerHTML = renderKpis();
  byId("profiles").innerHTML = renderProfiles();
  byId("opsWrap").innerHTML = renderOps();
  byId("analyticsCol").innerHTML = `<div class="card" id="analyticsCard">${renderAnalyticsShell()}</div>`;
  byId("newsBar").innerHTML = renderNewsBar();
  renderTicker();
  flashKpis();
  loadProfileSparks();
  loadTab();
  loadNews();
}

let reqSeq = 0;
async function refresh() {
  const my = ++reqSeq;
  try {
    const [dash, profiles, conns, trades] = await Promise.all([
      api.dashboard(store.state.view),
      api.profilesV2(store.state.period), // 0 = all-time; the route now accepts it directly
      api.connections(),
      api.trades(120, store.state.view === "consolidated" ? undefined : store.state.view),
    ]);
    if (my !== reqSeq) return;
    tradesCache = trades || [];
    store.set({ dashboard: dash, profiles: profiles || [], connections: conns || {}, daysRunning: dash?.daysRunning || 0 });
  } catch (e) { console.error("refresh failed", e); }
}

function wireEvents() {
  const app = document.querySelector(".app");
  on(app, "click", "[data-act]", async (e, el) => {
    const act = el.dataset.act;
    if (act === "theme") { const seq = ["dark", "terminal", "light"]; store.set({ theme: seq[(seq.indexOf(store.state.theme) + 1) % seq.length] }); render(); }
    else if (act === "lang") { store.set({ lang: store.state.lang === "en" ? "es" : "en" }); render(); }
    else if (act === "logout") { try { await api.logout(); } catch {} location.href = "/login"; }
    else if (act === "settings") openSettings((key) => { if (key === "period") refresh().then(render); else render(); });
    else if (act === "accounts") openAccounts();
    else if (act === "portfolios") openPortfolios();
    else if (act === "news-toggle") toggleNews();
    else if (act === "pnl-why") openPnlBreakdown(+el.dataset.days);
  });
  on(app, "click", "[data-sym]", (e, el) => openCandles(el.dataset.sym));
  on(app, "keydown", "[data-sym]", (e, el) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCandles(el.dataset.sym); } });
  on(app, "click", "[data-broker]", (e, el) => openBrokerModal(el.dataset.broker, (id) => { store.set({ view: id }); refresh().then(render); }));
  on(app, "keydown", "[data-broker]", (e, el) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
  on(app, "click", "[data-opstab]", (e, el) => { opsTab = el.dataset.opstab; byId("opsCard").outerHTML = renderOps(); });
  on(app, "click", "[data-atab]", (e, el) => setTab(el.dataset.atab));
  on(app, "click", "[data-period]", (e, el) => { store.set({ period: +el.dataset.period }); refresh().then(render); });
  on(app, "click", "[data-mr]", (e, el) => { setMonthlyReturnsProfile(el.dataset.mr); loadTab(); });
}

function setTab(id) {
  store.set({ tab: id });
  const card = byId("analyticsCard");
  if (card) { card.innerHTML = renderAnalyticsShell(); loadTab(); }
}

/** live updates: positions/prices in <1s; closes/orders trigger a debounced full refresh */
function wireWS() {
  connectWS({
    position_update: (d) => {
      if (!d?.symbol) return;
      const pos = store.state.dashboard?.portfolio?.positions || [];
      const p = pos.find((x) => x.symbol === d.symbol);
      if (!p) return;
      if (Number.isFinite(d.currentPrice)) p.currentPrice = d.currentPrice;
      if (Number.isFinite(d.unrealizedPnl)) p.unrealizedPnl = d.unrealizedPnl;
      if (Number.isFinite(d.unrealizedPnlPct)) p.unrealizedPnlPct = d.unrealizedPnlPct;
      if (opsTab === "positions") { const b = byId("opsBody"); if (b) b.innerHTML = renderPositions(store.state, tradesCache); }
    },
    trade_closed: debouncedRefresh,
    order: debouncedRefresh,
  });
}

function paletteActions() {
  // Dynamic: whatever sleeves the bot is actually running right now (id/label
  // straight from am.getAccountSummaries()) — no hardcoded/retired profile ids.
  const accounts = store.state.dashboard?.accounts || [];
  const views = [["consolidated", t("Consolidated", "Consolidado")], ...accounts.map((a) => [a.id, a.label])];
  const tabs = [["equity", "Equity"], ["performance", t("Performance", "Rendimiento")], ["activity", t("Activity", "Actividad")]];
  const acts = [];
  for (const [id, l] of views) acts.push({ label: `${t("View", "Vista")}: ${l}`, tag: "view", run: () => { store.set({ view: id }); refresh().then(render); } });
  for (const [id, l] of tabs) acts.push({ label: `${t("Tab", "Pestaña")}: ${l}`, tag: "tab", run: () => setTab(id) });
  for (const [v, l] of [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"], [0, t("All", "Todo")]]) acts.push({ label: `${t("Window", "Ventana")}: ${l}`, tag: "period", run: () => { store.set({ period: v }); refresh().then(render); } });
  acts.push({ label: t("Cycle theme", "Cambiar tema"), tag: "ui", run: () => { const seq = ["dark", "terminal", "light"]; store.set({ theme: seq[(seq.indexOf(store.state.theme) + 1) % seq.length] }); render(); } });
  acts.push({ label: t("Toggle language EN/ES", "Cambiar idioma EN/ES"), tag: "ui", run: () => { store.set({ lang: store.state.lang === "en" ? "es" : "en" }); render(); } });
  acts.push({ label: t("Log out", "Cerrar sesión"), tag: "session", run: () => api.logout().finally(() => location.href = "/login") });
  return acts;
}

async function boot() {
  applyTheme();
  const me = await api.me();
  if (!me) { location.href = "/login"; return; }
  setCsrf(me.csrfToken);
  wireEvents();
  bindPalette(paletteActions);
  await refresh();
  render();
  loadTicker();
  // Fear & Greed lands after the first paint — re-render just the KPI strip.
  // The index refreshes daily upstream; 30min polling is already generous.
  const rerenderKpis = () => { const el = byId("kpis"); if (el) el.innerHTML = renderKpis(); };
  loadFng(rerenderKpis);
  wireWS();
  // OAuth round-trip deep link: the accounts callback redirects to
  // /?accounts_oauth=…; surface the result in the Accounts panel and strip
  // the params so a reload doesn't replay the banner.
  const oauthRes = oauthResultFromSearch(location.search);
  if (oauthRes) { history.replaceState(null, "", location.pathname); openAccounts(oauthRes); }
  setInterval(async () => { await refresh(); render(); }, 30000);
  setInterval(loadTicker, 60000);
  setInterval(() => loadFng(rerenderKpis), 1_800_000);
  setInterval(tickClock, 1000);
}

boot();
