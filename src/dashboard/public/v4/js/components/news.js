import { store, t } from "../store.js";
import { byId, esc, icon } from "../ui.js";
import { ago } from "../fmt.js";

// News come from OUR server (GET /api/news — src/dashboard/routes/news.ts),
// which aggregates the RSS/Atom feeds with an 8s per-feed timeout and a
// 10-minute cache. The old client-side api.rss2json.com dependency (no
// timeout, refetched on every 30s render until the third-party quota ran
// out) is gone, and so is its CSP entry.
//
// Client contract: paint whatever is in memory INSTANTLY (never regress to
// the "…" placeholder once we have items) and ask the server at most every
// FETCH_EVERY_MS per language.

const FETCH_EVERY_MS = 10 * 60_000;
const memory = { en: { items: null, at: 0 }, es: { items: null, at: 0 } };

const slug = (s) => { const x = (s || "").toLowerCase(); return x.includes("cointelegraph") ? "cointelegraph" : x.includes("coindesk") ? "coindesk" : x.includes("bloomberg") ? "bloomberg" : x.includes("beincrypto") ? "beincrypto" : ""; };

let rotTimer = null, paused = false, inflight = null;

function cardsHtml(items) {
  return items.map((n) => {
    const url = /^https?:\/\//.test(n.link || "") ? n.link : null;
    // No real link → render as a non-interactive div, not a dead "#" anchor
    // that steals a tab stop and does nothing on click.
    const tag = url ? "a" : "div";
    const attrs = url ? `href="${esc(url)}" target="_blank" rel="noopener noreferrer"` : `role="presentation"`;
    return `<${tag} class="news-card" ${attrs} data-src="${slug(n.source)}">
      <div class="n-src">${esc(n.source)} <span class="n-lang">${esc(n.lang)}</span></div>
      <div class="n-title">${esc(n.title || "")}</div>
      <div class="n-time">${esc(n.pubDate ? ago(n.pubDate) : "")}</div></${tag}>`;
  }).join("");
}

function paint() {
  const el = byId("newsScroll");
  if (!el) return;
  const items = memory[store.state.lang === "es" ? "es" : "en"].items;
  if (items === null) return; // keep the "…" placeholder until the FIRST load resolves
  el.innerHTML = items.length
    ? cardsHtml(items)
    : `<div class="muted" style="padding:var(--s3)">${t("Couldn't reach news feeds", "No se pudo conectar a las fuentes")}</div>`;
  if (items.length) startRotation();
}

export async function loadNews() {
  if (!store.state.newsOpen) return; // collapsed by default — don't fetch what isn't shown
  const lang = store.state.lang === "es" ? "es" : "en";
  paint(); // instant: whatever we already have (never back to "…")
  const slot = memory[lang];
  if (slot.items !== null && Date.now() - slot.at < FETCH_EVERY_MS) return;
  if (inflight) return; // one request at a time
  inflight = (async () => {
    try {
      const res = await fetch(`/api/news?lang=${lang}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      slot.items = Array.isArray(data?.items) ? data.items : [];
      slot.at = Date.now();
    } catch {
      // Keep the old items (if any); retry is allowed immediately next call.
      if (slot.items === null) { slot.items = []; slot.at = 0; }
    } finally {
      inflight = null;
    }
    paint();
  })();
  await inflight;
}

function startRotation() {
  if (rotTimer) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const el = byId("newsScroll");
  if (!el) return;
  el.addEventListener("pointerenter", () => paused = true);
  el.addEventListener("pointerleave", () => paused = false);
  rotTimer = setInterval(() => {
    if (paused || document.hidden) return;
    // Re-fetch by id every tick — a periodic dashboard refresh replaces
    // #newsScroll's innerHTML, and the outer "el" would go stale/detached.
    const el = byId("newsScroll");
    if (!el) return;
    const card = el.querySelector(".news-card"); if (!card) return;
    const step = card.getBoundingClientRect().width + 12;
    const maxS = el.scrollWidth - el.clientWidth - 2;
    if (maxS <= 0) return;
    if (el.scrollLeft >= maxS) el.scrollTo({ left: 0, behavior: "smooth" });
    else el.scrollBy({ left: step, behavior: "smooth" });
  }, 6000);
}

export function renderNewsBar() {
  const open = !!store.state.newsOpen;
  return `<div class="card" style="margin-top:var(--s4)">
    <h3>
      <button class="card-note" data-act="news-toggle" aria-expanded="${open}" aria-controls="newsScroll"
        style="appearance:none;background:none;border:none;padding:0;margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-family:inherit">
        ${icon("news", 13)} ${t("Market News", "Noticias")}
        <span aria-hidden="true" style="transition:transform var(--dur);transform:rotate(${open ? "90deg" : "0deg"});display:inline-block">▸</span>
      </button>
    </h3>
    <div class="news-scroll" id="newsScroll" ${open ? "" : "hidden"}><div class="muted" style="padding:var(--s3)">…</div></div></div>`;
}

/** Flip open/closed, persist it (store.set writes localStorage for
 *  PERSIST-listed keys), re-render just this card, and lazy-load the feeds
 *  the first time it's opened. Wired from main.js's [data-act] delegator. */
export function toggleNews() {
  store.set({ newsOpen: !store.state.newsOpen });
  const bar = byId("newsBar");
  if (bar) bar.innerHTML = renderNewsBar();
  loadNews(); // no-op (early return) when this just closed it
}
