import { api, setCsrf } from "./api.js";
import { store, t } from "./store.js";
import { byId, on, esc, icon } from "./ui.js";
import { renderHeader, renderActions, renderNav, NAV_PAGES, tickClock } from "./components/header.js";
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
import { mountSettings } from "./components/settings.js";
import { mountAccounts, setPendingOauthResult, oauthResultFromSearch } from "./components/accounts.js";
import { mountPortfolios } from "./components/portfolios.js";
import { mountActivity } from "./components/activity.js";
import { pageFromHash } from "./router.js";
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
let tickerItemsHtml = "";
function renderTicker() {
  if (!tickerRows.length) { byId("ticker").hidden = true; return; }
  tickerItemsHtml = tickerRows.map((x) =>
    `<span class="t">${esc(x.sym)} <b>$${num(x.price, x.price < 10 ? 4 : 2)}</b> <span style="color:${x.chg >= 0 ? "var(--up)" : "var(--down)"}">${x.chg >= 0 ? "▲" : "▼"} ${num(Math.abs(x.chg), 2)}%</span></span>`
  ).join("");
  // Two identical flex halves → translateX(-50%) lands exactly on the seam
  // (see .ticker-half in app.css). Second copy is decorative for a11y.
  byId("tickerIn").innerHTML = `<div class="ticker-half">${tickerItemsHtml}</div><div class="ticker-half" aria-hidden="true">${tickerItemsHtml}</div>`;
  byId("ticker").hidden = false;
  sizeTicker();
}

/** Seamless-marquee sizing (2026-10-06): with few symbols one .ticker-half
 *  measured LESS than a wide viewport, so the −50% loop left a visible gap.
 *  Repeat the item set inside each half until the half covers the container,
 *  and scale the animation duration to the half's width so the speed stays
 *  ~constant (TICKER_PX_PER_S) on every viewport. Re-run on resize. Hover
 *  pause + prefers-reduced-motion are CSS (.ticker in app.css). */
const TICKER_PX_PER_S = 40;
function sizeTicker() {
  const wrap = byId("ticker"), inner = byId("tickerIn");
  if (!wrap || wrap.hidden || !inner || !tickerItemsHtml) return;
  const halves = inner.querySelectorAll(".ticker-half");
  if (halves.length < 2) return;
  halves[0].innerHTML = tickerItemsHtml; // single copy → measure the unit
  const unit = halves[0].getBoundingClientRect().width;
  if (!(unit > 0)) return;
  const copies = Math.max(1, Math.ceil(wrap.clientWidth / unit));
  const full = tickerItemsHtml.repeat(copies);
  for (const h of halves) h.innerHTML = full;
  const halfWidth = halves[0].getBoundingClientRect().width;
  inner.style.animationDuration = `${Math.max(10, Math.round(halfWidth / TICKER_PX_PER_S))}s`;
}
let tickerResizeT = null;
window.addEventListener("resize", () => { clearTimeout(tickerResizeT); tickerResizeT = setTimeout(sizeTicker, 250); });

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

/** The ops card's scroller: the table box when it scrolls, else the card
 *  body (layouts where the box is capped or not a scroller). */
function opsScroller() {
  return document.querySelector("#opsBody > .scroll") || byId("opsBody");
}
/** Run a re-render of the ops card without yanking the reader back to the
 *  top: the 30 s refresh rebuilds the page and WS price ticks rebuild the
 *  table (2026-10-07: the table box became the scroller so its header and
 *  totals rows can stick). A tab switch starts at the top. */
function withOpsScroll(fn) {
  const before = opsScroller();
  const saved = before ? { tab: opsTab, top: before.scrollTop, left: before.scrollLeft } : null;
  fn();
  const after = opsScroller();
  if (after && saved && saved.tab === opsTab) {
    after.scrollTop = saved.top;
    after.scrollLeft = saved.left;
  }
}

// ── hash router (#/resumen · #/portafolios · #/cuentas · #/actividad ·
// #/ajustes). The hash is the source of truth; the store remembers the last
// page for hash-less loads (PERSIST). Back/forward work via hashchange. ──
function pageShell(iconName, title) {
  return `<div class="card page-card"><h3><span style="display:inline-flex;align-items:center;gap:6px">${icon(iconName, 15)} ${esc(title)}</span></h3><div class="page-body" id="pageBody"><div class="muted">…</div></div></div>`;
}

/** Header + nav + KPI strip — shared by every page. */
function renderChrome() {
  applyTheme();
  byId("hdr").innerHTML = renderHeader();
  byId("hdrActions").innerHTML = renderActions();
  byId("nav").innerHTML = renderNav();
  byId("kpis").innerHTML = renderKpis();
  renderTicker();
  flashKpis();
}

function renderPage() {
  const page = store.state.page;
  const host = byId("page");
  if (page === "portafolios") {
    host.innerHTML = pageShell("briefcase", t("Portfolios", "Portafolios"));
    mountPortfolios(byId("pageBody"));
  } else if (page === "cuentas") {
    host.innerHTML = pageShell("box", t("Broker accounts", "Cuentas de broker"));
    mountAccounts(byId("pageBody"));
  } else if (page === "actividad") {
    host.innerHTML = pageShell("list", t("Activity", "Actividad"));
    mountActivity(byId("pageBody"), tradesCache);
  } else if (page === "ajustes") {
    host.innerHTML = pageShell("settings", t("Settings", "Ajustes"));
    mountSettings(byId("pageBody"), (key) => { if (key === "period") refresh().then(render); else render(); });
  } else {
    // Resumen — the original monitor screen.
    withOpsScroll(() => {
      host.innerHTML = `<div class="grid cols-2 profiles-grid" id="profiles"></div>
        <div class="main-area" id="mainArea"><div class="ops-wrap" id="opsWrap"></div><div class="an-col" id="analyticsCol"></div></div>
        <div id="newsBar"></div>`;
      byId("profiles").innerHTML = renderProfiles();
      byId("opsWrap").innerHTML = renderOps();
    });
    byId("analyticsCol").innerHTML = `<div class="card" id="analyticsCard">${renderAnalyticsShell()}</div>`;
    byId("newsBar").innerHTML = renderNewsBar();
    loadProfileSparks();
    loadTab();
    loadNews();
  }
}

function render() {
  renderChrome();
  renderPage();
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

function toggleUserMenu(force) {
  const m = byId("umenu");
  if (!m) return;
  const open = force !== undefined ? force : m.hidden;
  m.hidden = !open;
  document.querySelector('[data-act="user-menu"]')?.setAttribute("aria-expanded", String(open));
}

function wireEvents() {
  const app = document.querySelector(".app");
  on(app, "click", "[data-act]", async (e, el) => {
    const act = el.dataset.act;
    if (act === "theme") { const seq = ["dark", "terminal", "light"]; store.set({ theme: seq[(seq.indexOf(store.state.theme) + 1) % seq.length] }); render(); }
    else if (act === "lang") { store.set({ lang: store.state.lang === "en" ? "es" : "en" }); render(); }
    else if (act === "logout") { try { await api.logout(); } catch {} location.href = "/login"; }
    else if (act === "user-menu") toggleUserMenu();
    else if (act === "user-menu-close") toggleUserMenu(false);
    else if (act === "news-toggle") toggleNews();
    else if (act === "pnl-why") openPnlBreakdown(+el.dataset.days);
  });
  // Click-away / Escape close the user menu.
  document.addEventListener("click", (e) => {
    const m = byId("umenu");
    if (m && !m.hidden && !e.target.closest(".uchip-wrap")) toggleUserMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleUserMenu(false); });
  // Router: back/forward + direct links.
  window.addEventListener("hashchange", () => {
    const p = pageFromHash(location.hash);
    if (p && p !== store.state.page) { store.set({ page: p }); render(); }
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
      if (opsTab === "positions") { const b = byId("opsBody"); if (b) withOpsScroll(() => { b.innerHTML = renderPositions(store.state, tradesCache); }); }
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
  for (const [id, , label] of NAV_PAGES()) acts.push({ label: `${t("Go to", "Ir a")}: ${label}`, tag: "nav", run: () => { location.hash = "#/" + id; } });
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
  store.set({ me });
  // Router init: an explicit hash wins; otherwise restore the remembered page.
  const hashPage = pageFromHash(location.hash);
  const page = hashPage || store.state.page || "resumen";
  store.set({ page });
  if (!hashPage) history.replaceState(null, "", "#/" + page);
  wireEvents();
  bindPalette(paletteActions);
  // Identity (account id for the user chip; Ajustes shows the rest). Soft:
  // null until the Phase-3 backend ships / on older servers.
  api.platformMe().then((pm) => { if (pm) { store.set({ platformMe: pm }); byId("hdrActions").innerHTML = renderActions(); } });
  await refresh();
  render();
  loadTicker();
  // Fear & Greed lands after the first paint — re-render just the KPI strip.
  // The index refreshes daily upstream; 30min polling is already generous.
  const rerenderKpis = () => { const el = byId("kpis"); if (el) el.innerHTML = renderKpis(); };
  loadFng(rerenderKpis);
  wireWS();
  // OAuth round-trip deep link: the accounts callback redirects to
  // /?accounts_oauth=…; land on the Accounts page with the result banner and
  // strip the params so a reload doesn't replay it.
  const oauthRes = oauthResultFromSearch(location.search);
  if (oauthRes) {
    setPendingOauthResult(oauthRes);
    history.replaceState(null, "", location.pathname + "#/cuentas");
    if (store.state.page !== "cuentas") { store.set({ page: "cuentas" }); render(); }
  }
  // Periodic refresh repaints the whole Resumen; on other pages only the
  // chrome (header/KPIs) — a full repaint would wipe form/scroll state.
  setInterval(async () => { await refresh(); if (store.state.page === "resumen") render(); else renderChrome(); }, 30000);
  setInterval(loadTicker, 60000);
  setInterval(() => loadFng(rerenderKpis), 1_800_000);
  setInterval(tickClock, 1000);
}

boot();
