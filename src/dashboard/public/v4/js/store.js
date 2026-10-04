// ── store.js — small reactive state. Not Redux; just a plain object + subscribe.
// Persisted keys survive reloads. Components read store.state and subscribe to
// re-render on change.

const PERSIST = ["view", "period", "lang", "theme", "tab", "newsOpen"];
const load = (k, d) => { try { const v = localStorage.getItem("uc4_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };

export const store = {
  state: {
    view: load("view", "consolidated"),     // consolidated | a live sleeve id (dynamic, see dashboard.accounts)
    period: load("period", 1),              // 1 | 7 | 30 | 0(all)  — global time filter
    lang: load("lang", "en"),               // en | es
    theme: load("theme", "dark"),           // dark | terminal | light
    tab: load("tab", "equity"),             // active analytics tab (Equity is always useful, unlike Portfolio which duplicates Positions when empty)
    // Market News card: closed by default (2026-09-24 audit fix — it used to
    // always render open, eating ~20% of the viewport before first paint).
    newsOpen: load("newsOpen", false),
    // live data (not persisted)
    dashboard: null,
    profiles: [],
    connections: {},
    daysRunning: 0,
  },
  _subs: new Set(),
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  set(patch) {
    Object.assign(this.state, patch);
    for (const k of Object.keys(patch)) if (PERSIST.includes(k)) {
      try { localStorage.setItem("uc4_" + k, JSON.stringify(this.state[k])); } catch {}
    }
    for (const fn of this._subs) { try { fn(this.state, patch); } catch (e) { console.error(e); } }
  },
};

export const periodLabel = (p) => p === 0 ? "All" : p === 1 ? "Today" : `${p}D`;
export const isEs = () => store.state.lang === "es";
export const t = (en, es) => (isEs() ? es : en);
