import { store, t } from "../store.js";
import { byId, esc, icon } from "../ui.js";
import { ago } from "../fmt.js";

const FEEDS = {
  en: ["https://cointelegraph.com/rss", "https://www.coindesk.com/arc/outboundfeeds/rss", "https://feeds.bloomberg.com/markets/news.rss"],
  es: ["https://es.beincrypto.com/feed/"],
};

// rss2json emits "YYYY-MM-DD HH:MM:SS" in UTC with no zone; parse as UTC so a
// browser west of UTC doesn't land in the future → "just now" for everything.
function newsDate(s) {
  if (!s) return NaN;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(s).trim());
  return m ? Date.parse(m[1] + "T" + m[2] + "Z") : Date.parse(s);
}
const slug = (s) => { const x = (s || "").toLowerCase(); return x.includes("cointelegraph") ? "cointelegraph" : x.includes("coindesk") ? "coindesk" : x.includes("bloomberg") ? "bloomberg" : x.includes("beincrypto") ? "beincrypto" : ""; };

let rotTimer = null, paused = false;

export async function loadNews() {
  if (!store.state.newsOpen) return; // collapsed by default — don't fetch what isn't shown
  const el = byId("newsScroll");
  if (!el) return;
  const lang = store.state.lang;
  const feeds = [...FEEDS.en.map((u) => ({ u, l: "EN" })), ...(lang === "es" ? FEEDS.es.map((u) => ({ u, l: "ES" })) : [])];
  const res = await Promise.allSettled(feeds.map(async (f) => {
    const d = await (await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(f.u)}`)).json();
    return (d.items || []).map((i) => ({ ...i, lang: f.l, source: d.feed?.title || "News" }));
  }));
  let all = [];
  for (const r of res) if (r.status === "fulfilled") all.push(...r.value);
  const seen = new Set();
  all = all.filter((n) => { const k = n.title?.slice(0, 40); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (newsDate(b.pubDate) || 0) - (newsDate(a.pubDate) || 0)).slice(0, 25);
  if (!all.length) { el.innerHTML = `<div class="muted" style="padding:var(--s3)">${t("Couldn't reach news feeds", "No se pudo conectar a las fuentes")}</div>`; return; }
  el.innerHTML = all.map((n) => {
    const url = /^https?:\/\//.test(n.link || "") ? n.link : null;
    // No real link → render as a non-interactive div, not a dead "#" anchor
    // that steals a tab stop and does nothing on click.
    const tag = url ? "a" : "div";
    const attrs = url ? `href="${esc(url)}" target="_blank" rel="noopener noreferrer"` : `role="presentation"`;
    return `<${tag} class="news-card" ${attrs} data-src="${slug(n.source)}">
      <div class="n-src">${esc(n.source)} <span class="n-lang">${esc(n.lang)}</span></div>
      <div class="n-title">${esc(n.title || "")}</div>
      <div class="n-time">${esc(ago(newsDate(n.pubDate)))}</div></${tag}>`;
  }).join("");
  startRotation();
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
