import { icon, esc } from "../ui.js";
import { store, t } from "../store.js";
import { etTime, money, n } from "../fmt.js";

const ET = "America/New_York";
const etDay = () => new Date().toLocaleDateString("en-US", { timeZone: ET, weekday: "short", day: "2-digit", month: "short" });

// ponytail: static URLs — the whole deployment is paper/testnet by design (AGENTS.md)
const BROKER_URL = { alpaca: "https://app.alpaca.markets", binance: "https://testnet.binancefuture.com" };

/** Plain single-figure balance pill (Alpaca: one USD-denominated account). */
function simpleBalance(account) {
  return typeof account.equity === "number" && Number.isFinite(account.equity)
    ? ` <span class="pill-balance">${money(account.equity)}</span>` : "";
}

/** Binance wallet decomposition (mandate 2026-07-19): FOUR independently-
 *  sourced components — USDT Futures margin equity, USDC Futures margin
 *  equity, FAPI BTC collateral USD, COIN-M BTC margin equity — each present
 *  only when its sleeve/asset is actually active. The displayed Total is
 *  built BOTTOM-UP as the sum of whatever components are present (never a
 *  separately-fetched total that components are then subtracted from/added
 *  to — "do not start from total then add assets"), so it is correct by
 *  construction and every included bucket is labeled, not implied. */
function binanceBalance(account) {
  const b = account.marginBreakdown;
  if (!b) return "";
  const parts = [];
  if (Number.isFinite(b.usdtFutures)) parts.push(["USDT Futures", b.usdtFutures]);
  if (Number.isFinite(b.usdcFutures)) parts.push(["USDC Futures", b.usdcFutures]);
  if (Number.isFinite(b.fapiBtcCollateral)) parts.push(["FAPI BTC collateral", b.fapiBtcCollateral]);
  if (Number.isFinite(b.coinmMargin)) parts.push(["COIN-M BTC margin", b.coinmMargin]);
  if (!parts.length) return "";
  const total = parts.reduce((sum, [, v]) => sum + n(v), 0);
  const labeled = parts.map(([label, v]) => `${label} ${money(v)}`);
  const title = `Total ${money(total)} = ${labeled.join(" + ")} — every included bucket is labeled here, not additive with anything else`;
  return ` <span class="pill-balance" title="${esc(title)}">${money(total)}<span class="pill-sub"> · ${labeled.map(esc).join(" · ")}</span></span>`;
}

function connPill(label, broker, c, balanceHtml) {
  const on = !!(c && (c.connected || c.dataConnected));
  const status = on ? t("connected", "conectado") : t("disconnected", "desconectado");
  return `<a class="pill" href="${BROKER_URL[broker]}" target="_blank" rel="noopener" title="${label} ↗" aria-label="${esc(label)} — ${status}"><span class="dot ${on ? "on" : "off"}"></span>${label}${balanceHtml}</a>`;
}

export function renderHeader() {
  const s = store.state;
  const c = s.connections || {};
  const accounts = (s.profiles || []).flatMap((profile) => profile.brokerAccounts || []);
  const alpacaAcc  = accounts.find((a) => String(a.brokerId || "").includes("alpaca"));
  const binanceAcc = accounts.find((a) => String(a.brokerId || "").includes("binance"));
  return `
    <div class="brand">${icon("trend", 20)} Uncle Carl <span class="ver">v4</span>
      <span class="clock" id="clock">${esc(etDay())} · ${etTime(Date.now())}</span></div>
    <div class="hdr-brokers">
      ${connPill("Alpaca", "alpaca", c.alpaca, alpacaAcc ? simpleBalance(alpacaAcc) : "")}
      ${connPill("Binance", "binance", c.binance, binanceAcc ? binanceBalance(binanceAcc) : "")}
    </div>
  `;
}

/** Right-side icon actions — split out of renderHeader so the KPI strip can sit
 *  between the broker pills and these buttons on ONE merged top row (#topbar). */
export function renderActions() {
  return `
    <button class="icn" data-act="lang" title="${t("Language", "Idioma")}">${icon("globe")}</button>
    <button class="icn" data-act="theme" title="${t("Theme", "Tema")}">${icon("moon")}</button>
    <button class="icn" data-act="accounts" title="${t("Broker accounts", "Cuentas de broker")}">${icon("box")}</button>
    <button class="icn" data-act="portfolios" title="${t("Portfolios", "Portafolios")}">${icon("trend")}</button>
    <button class="icn" data-act="settings" title="${t("Settings", "Ajustes")}">${icon("settings")}</button>
    <button class="icn danger" data-act="logout" title="${t("Log out", "Salir")}">${icon("logout")}</button>
  `;
}

export function tickClock() {
  const el = document.getElementById("clock");
  if (el) el.textContent = `${etDay()} · ${etTime(Date.now())}`;
}
