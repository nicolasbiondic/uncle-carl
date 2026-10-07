// ── portfolio-manager chrome: labeled actions, nav with visible labels,
// user chip + menu (2026-10-06) ─────────────────────────────────────────
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { actionButton, renderActions, renderNav, renderUserChip, NAV_PAGES } from "./header.js";

const original = { ...store.state };
afterEach(() => Object.assign(store.state, original));

describe("actionButton", () => {
  test("carries a visible label span AND an aria-label", () => {
    const html = actionButton("theme", "moon", "Theme");
    expect(html).toContain('aria-label="Theme"');
    expect(html).toContain('<span class="icn-l">Theme</span>');
    expect(html).toContain('data-act="theme"');
  });
});

describe("renderNav", () => {
  test("all five pages with hash links and visible labels", () => {
    Object.assign(store.state, { lang: "es", page: "cuentas" });
    const html = renderNav();
    for (const [id] of NAV_PAGES()) expect(html).toContain(`href="#/${id}"`);
    expect(html).toContain(">Resumen<");
    expect(html).toContain(">Portafolios<");
    expect(html).toContain(">Cuentas<");
    expect(html).toContain(">Actividad<");
    expect(html).toContain(">Ajustes<");
  });
  test("the active page is marked with aria-current", () => {
    Object.assign(store.state, { page: "portafolios" });
    const html = renderNav();
    expect(html).toMatch(/class="nav-link on" href="#\/portafolios" aria-current="page"/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });
});

describe("renderUserChip", () => {
  test("shows the display name and, when platformMe exists, the short id", () => {
    Object.assign(store.state, { me: { displayName: "Owner", username: "owner" }, platformMe: { accountId: "acct_3f9c2a1b7d42" } });
    const html = renderUserChip();
    expect(html).toContain("Owner");
    expect(html).toContain("#3f9c2a");
    expect(html).toContain('aria-haspopup="menu"');
  });
  test("menu offers Ajustes and Salir", () => {
    Object.assign(store.state, { lang: "es", me: { displayName: "Owner" }, platformMe: null });
    const html = renderUserChip();
    expect(html).toContain('href="#/ajustes"');
    expect(html).toContain('data-act="logout"');
    expect(html).not.toContain("#undefined");
  });
});

describe("renderActions", () => {
  test("lang + theme + user chip; no bare unlabeled buttons", () => {
    Object.assign(store.state, { me: { displayName: "Owner" } });
    const html = renderActions();
    expect(html).toContain('data-act="lang"');
    expect(html).toContain('data-act="theme"');
    expect(html).toContain('data-act="user-menu"');
    // every toolbar button has an aria-label (menu items carry visible text)
    const buttons = html.match(/<button[^>]*class="icn[^>]*>/g) || [];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect(b).toContain("aria-label=");
  });
});
