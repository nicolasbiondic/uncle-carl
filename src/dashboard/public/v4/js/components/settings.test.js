// ── Ajustes page: three columns of cards (owner 2026-10-11: "demasiado
// espacio en blanco … hazlo en varias columnas"; broker accounts moved in the
// same day: "Settings y Accounts podrían estar juntos") + the row helpers ──
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { deviceLabel, loginMethodsHtml, sessionRowHtml, settingsLayoutHtml } from "./settings.js";

const original = { ...store.state };
afterEach(() => Object.assign(store.state, original));

const STATE = {
  lang: "en", theme: "dark", period: 1,
  me: { displayName: "Owner", username: "owner", role: "admin" },
  platformMe: {
    accountId: "acct_3f9c2a1b7d42", instanceId: "7b1f2d34-5a6c-4e89-9d01-23456789abcd",
    loginMethods: { password: true, github: true, google: false },
    accountsSource: "registry", portfoliosSource: "db", commit: "e8e672b", publicUrl: "https://bot.example.com",
  },
};

/** Card ids per column, in order. */
function columns(html) {
  return html.split('<div class="set-col">').slice(1).map((col) => [...col.matchAll(/data-set-card="([a-z]+)"/g)].map((m) => m[1]));
}

/** The HTML of one card (up to the next card or the end). */
function cardHtml(html, id) {
  const start = html.indexOf(`data-set-card="${id}"`);
  const next = html.indexOf("data-set-card=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("settingsLayoutHtml", () => {
  test("three columns: you (account, preferences) | connections (broker accounts, sessions) | system (sign-in, installation)", () => {
    Object.assign(store.state, STATE);
    const html = settingsLayoutHtml(store.state);
    expect(html.startsWith('<div class="set-grid">')).toBe(true);
    expect(columns(html)).toEqual([["account", "preferences"], ["brokers", "sessions"], ["signin", "installation"]]);
    expect(html).toContain('id="setSessions"');
    expect(cardHtml(html, "brokers")).toContain('id="setBrokers"');
    expect(cardHtml(html, "brokers")).toContain(" Broker accounts</h4>");
  });

  test("the installation ID sits in the Installation card, the account ID in Account, both copyable", () => {
    Object.assign(store.state, STATE);
    const html = settingsLayoutHtml(store.state);
    const account = cardHtml(html, "account");
    const install = cardHtml(html, "installation");
    expect(account).toContain('data-copy="acct_3f9c2a1b7d42"');
    expect(account).not.toContain("7b1f2d34");
    expect(install).toContain('data-copy="7b1f2d34-5a6c-4e89-9d01-23456789abcd"');
    expect(install).toContain(">Installation ID<");
    expect(install).toContain('<code class="set-id">7b1f2d34-5a6c-4e89-9d01-23456789abcd</code>');
    expect(html).not.toContain("#/cuentas"); // the accounts are on this page now
  });

  test("Spanish labels, and a missing platform identity degrades to the basic rows", () => {
    Object.assign(store.state, { ...STATE, lang: "es", platformMe: null });
    const html = settingsLayoutHtml(store.state);
    expect(html).toContain("Cuenta");
    expect(html).toContain("Instalación");
    expect(html).not.toContain("data-copy=");
    expect(cardHtml(html, "signin")).toContain("Contraseña");
  });
});

describe("row helpers", () => {
  test("sessionRowHtml: compact action, current session labeled", () => {
    Object.assign(store.state, { lang: "en" });
    const cur = sessionRowHtml({ handle: "a1", device: "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130", ip: "1.2.3.4", createdAt: 1, lastActivity: 2, current: true });
    expect(cur).toContain('class="set-row set-sess"');
    expect(cur).toContain('class="acc-btn danger sm"');
    expect(cur).toContain("this session");
    expect(cur).toContain(">Log out<");
    const other = sessionRowHtml({ handle: "b2", device: "", ip: "", createdAt: 0, lastActivity: 0, current: false });
    expect(other).toContain(">Revoke<");
    expect(other).not.toContain("this session");
  });

  test("loginMethodsHtml marks enabled methods", () => {
    Object.assign(store.state, { lang: "en" });
    const html = loginMethodsHtml({ password: true, github: false, google: true });
    expect(html.match(/✓ enabled/g)?.length).toBe(2);
  });

  test("deviceLabel", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1")).toBe("Safari · iOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0")).toBe("Chrome · Linux");
  });
});
