// ── portfolio-manager chrome: labeled actions, nav with visible labels,
// user chip + menu (2026-10-06) ─────────────────────────────────────────
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { actionButton, renderActions, renderNav, renderUserChip, nextMenuIndex, NAV_PAGES } from "./header.js";

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
  test("four pages with hash links and visible labels — broker accounts live in Ajustes (2026-10-11)", () => {
    Object.assign(store.state, { lang: "es", page: "ajustes" });
    const html = renderNav();
    expect(NAV_PAGES().map(([id]) => id)).toEqual(["resumen", "portafolios", "actividad", "ajustes"]);
    for (const [id] of NAV_PAGES()) expect(html).toContain(`href="#/${id}"`);
    expect(html).toContain(">Resumen<");
    expect(html).toContain(">Portafolios<");
    expect(html).toContain(">Actividad<");
    expect(html).toContain(">Ajustes<");
    expect(html).not.toContain("#/cuentas");
  });
  test("the active page is marked with aria-current", () => {
    Object.assign(store.state, { page: "portafolios" });
    const html = renderNav();
    expect(html).toMatch(/class="nav-link on" href="#\/portafolios" aria-current="page"/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });
});

describe("renderUserChip", () => {
  test("the chip shows only the display name; the short id and version live in the menu (2026-10-25)", () => {
    Object.assign(store.state, { me: { displayName: "Owner", username: "owner" }, platformMe: { accountId: "acct_3f9c2a1b7d42" } });
    const html = renderUserChip();
    const chip = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    expect(chip).toContain("Owner");
    expect(chip).not.toContain("#3f9c2a");
    expect(html).toContain("#3f9c2a");
    expect(html).toContain('<span class="mono">v4</span>');
    expect(html.indexOf("#3f9c2a")).toBeGreaterThan(html.indexOf('id="umenu"'));
    expect(html).toContain('aria-haspopup="menu"');
  });
  test("closed by default, open on request, aria-expanded in step", () => {
    expect(renderUserChip()).toContain('aria-expanded="false"');
    expect(renderUserChip()).toMatch(/id="umenu" hidden/);
    expect(renderUserChip(true)).toContain('aria-expanded="true"');
    expect(renderUserChip(true)).not.toMatch(/id="umenu" hidden/);
  });
  test("menu holds Language and Theme with their current values, in both languages", () => {
    Object.assign(store.state, { lang: "es", theme: "terminal", me: { displayName: "Owner" } });
    let html = renderUserChip();
    expect(html).toContain('data-act="lang"');
    expect(html).toContain('data-act="theme"');
    expect(html).toContain("Idioma");
    expect(html).toContain("Tema");
    expect(html).toContain(">Español<");
    expect(html).toContain(">Terminal<");
    Object.assign(store.state, { lang: "en", theme: "light" });
    html = renderUserChip();
    expect(html).toContain("Language");
    expect(html).toContain("Theme");
    expect(html).toContain(">English<");
    expect(html).toContain(">Light<");
  });
  test("no account line without platformMe, never '#undefined'", () => {
    Object.assign(store.state, { me: { displayName: "Owner" }, platformMe: null });
    const html = renderUserChip();
    expect(html).not.toContain("#undefined");
    expect(html).not.toContain("#<");
    expect(html).toContain("v4");
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
  test("one toolbar button (the user chip) with an aria-label; lang + theme moved into its menu", () => {
    Object.assign(store.state, { me: { displayName: "Owner" } });
    const html = renderActions();
    expect(html).toContain('data-act="lang"');
    expect(html).toContain('data-act="theme"');
    expect(html).toContain('data-act="user-menu"');
    const buttons = html.match(/<button[^>]*class="icn[^>]*>/g) || [];
    expect(buttons.length).toBe(1);
    for (const b of buttons) expect(b).toContain("aria-label=");
    // lang/theme are menu items now, not toolbar buttons
    expect(html).not.toMatch(/class="icn[^"]*"[^>]*data-act="(lang|theme)"/);
  });
});

describe("nextMenuIndex", () => {
  test("arrows wrap, Home/End jump, other keys are ignored", () => {
    expect(nextMenuIndex("ArrowDown", -1, 4)).toBe(0);
    expect(nextMenuIndex("ArrowDown", 3, 4)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, 4)).toBe(3);
    expect(nextMenuIndex("ArrowUp", -1, 4)).toBe(3);
    expect(nextMenuIndex("Home", 2, 4)).toBe(0);
    expect(nextMenuIndex("End", 0, 4)).toBe(3);
    expect(nextMenuIndex("a", 0, 4)).toBeNull();
    expect(nextMenuIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
