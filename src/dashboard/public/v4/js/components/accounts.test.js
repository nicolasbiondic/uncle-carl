// ── accounts.js pure helpers — labels, status mapping, OAuth deep-link
// parsing, and the render functions' three states (unconfigured install,
// empty list, populated rows). DOM-interaction paths (slideover/modal) are
// not unit-tested here, matching the other v4 components.
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import {
  providerLabel, envLabel, statusInfo, fmtWhen, authTypeLabel,
  oauthResultFromSearch, oauthResultMessage, multiVerifiedUnlinked,
  renderAccountRow, renderAccountsList, renderAccountDetail, renderBinanceSecurityTips, renderAddModal,
} from "./accounts.js";

const originalLang = store.state.lang;
afterEach(() => { store.state.lang = originalLang; });

describe("labels", () => {
  test("providerLabel maps the two registry providers and passes unknowns through", () => {
    expect(providerLabel("alpaca")).toBe("Alpaca");
    expect(providerLabel("binance_usdm")).toBe("Binance USDⓈ-M");
    expect(providerLabel("kraken")).toBe("kraken");
  });
  test("envLabel is bilingual only where the word differs (live)", () => {
    store.state.lang = "en";
    expect(envLabel("live")).toBe("Live");
    store.state.lang = "es";
    expect(envLabel("live")).toBe("Real");
    expect(envLabel("paper")).toBe("Paper");
    expect(envLabel("demo")).toBe("Demo");
  });
  test("statusInfo maps verified/error/unverified to distinct classes", () => {
    store.state.lang = "es";
    expect(statusInfo("verified")).toEqual({ cls: "ok", label: "Verificada" });
    expect(statusInfo("error").cls).toBe("err");
    expect(statusInfo("unverified").cls).toBe("warn");
  });
  test("fmtWhen renders a dash for null/0 and a date string otherwise", () => {
    expect(fmtWhen(null)).toBe("—");
    expect(fmtWhen(0)).toBe("—");
    expect(fmtWhen(1760000000000)).not.toBe("—");
  });
});

describe("oauthResultFromSearch", () => {
  test("parses ok, error, and absence", () => {
    expect(oauthResultFromSearch("?accounts_oauth=ok&id=mi-alpaca")).toEqual({ ok: true, id: "mi-alpaca" });
    expect(oauthResultFromSearch("?accounts_oauth=error&reason=bad_state")).toEqual({ ok: false, reason: "bad_state" });
    expect(oauthResultFromSearch("?view=consolidated")).toBeNull();
    expect(oauthResultFromSearch("")).toBeNull();
  });
  test("messages: known reasons are translated, unknown ones stay visible verbatim", () => {
    store.state.lang = "es";
    expect(oauthResultMessage({ ok: false, reason: "bad_state" })).toContain("caducado");
    expect(oauthResultMessage({ ok: false, reason: "weird_reason" })).toContain("weird_reason");
    expect(oauthResultMessage({ ok: true, id: "x" })).toContain("x");
    expect(oauthResultMessage(null)).toBe("");
  });
});

const acc = {
  id: "my-alpaca", provider: "alpaca", label: "My Alpaca", environment: "paper",
  authType: "api_key", status: "verified", accountRef: "PA3TESTNUM",
  lastVerifiedAt: 1760000000000, lastError: null,
};

describe("renderAccountsList", () => {
  test("unconfigured install shows the bun run setup banner", () => {
    store.state.lang = "es";
    const html = renderAccountsList({ configured: false, accounts: [] });
    expect(html).toContain("Instalación sin configurar");
    expect(html).toContain("bun run setup");
  });
  test("empty list shows the empty state, not rows", () => {
    const html = renderAccountsList({ configured: true, accounts: [] });
    expect(html).not.toContain("acc-row");
  });
  test("rows carry broker, env, status, account number and last verification — and verify/remove actions", () => {
    store.state.lang = "en";
    const html = renderAccountsList({ configured: true, accounts: [acc] });
    expect(html).toContain("Alpaca");
    expect(html).toContain("Paper");
    expect(html).toContain("Verified");
    expect(html).toContain("PA3TESTNUM");
    expect(html).toContain('data-acc-verify="my-alpaca"');
    expect(html).toContain('data-acc-del="my-alpaca"');
  });
  test("a failed account surfaces its (redacted) lastError, escaped", () => {
    const html = renderAccountRow({ ...acc, status: "error", lastError: 'HTTP 401 <script>"x"</script>' });
    expect(html).toContain("HTTP 401");
    expect(html).not.toContain("<script>");
  });
  test("null payload degrades to a could-not-load note", () => {
    store.state.lang = "en";
    expect(renderAccountsList(null)).toContain("Could not load");
  });
});

describe("portfolio-manager account rows (2026-10-06)", () => {
  test("statusInfo knows 'revoked'; authTypeLabel maps both auth kinds", () => {
    store.state.lang = "en";
    expect(statusInfo("revoked")).toEqual({ cls: "warn", label: "Revoked" });
    expect(authTypeLabel("oauth")).toBe("OAuth");
    expect(authTypeLabel("api_key")).toBe("API keys");
  });

  test("a runtime-linked row shows the in-use badge and disables Revoke/Remove with the reason", () => {
    store.state.lang = "en";
    const html = renderAccountRow({ ...acc, runtimeLinked: true });
    expect(html).toContain("In use by the bot");
    expect(html).toMatch(/data-acc-revoke="my-alpaca" disabled title="[^"]+"/);
    expect(html).toMatch(/data-acc-del="my-alpaca" disabled title="[^"]+"/);
    expect(html).toContain('data-acc-view="my-alpaca"');
  });

  test("a revoked row hides Revoke, disables Verify with a reconnect hint, keeps Remove", () => {
    store.state.lang = "en";
    const html = renderAccountRow({ ...acc, status: "revoked", runtimeLinked: false });
    expect(html).toContain("Revoked");
    expect(html).not.toContain("data-acc-revoke");
    expect(html).toMatch(/data-acc-verify="my-alpaca" disabled/);
    expect(html).toContain('data-acc-del="my-alpaca"');
  });

  test("multiVerifiedUnlinked flags a provider with >1 verified and no link; a link or a single account silences it", () => {
    const a = (id, over = {}) => ({ ...acc, id, runtimeLinked: false, ...over });
    expect(multiVerifiedUnlinked([a("x"), a("y")])).toEqual(["Alpaca"]);
    expect(multiVerifiedUnlinked([a("x"), a("y", { runtimeLinked: true })])).toEqual([]);
    expect(multiVerifiedUnlinked([a("x")])).toEqual([]);
    expect(multiVerifiedUnlinked([a("x"), a("y", { status: "revoked" })])).toEqual([]);
    const html = renderAccountsList({ configured: true, accounts: [a("x"), a("y")] });
    expect(html).toContain("role=\"alert\"");
  });

  test("renderAccountDetail shows the redacted record and never a secret-shaped field", () => {
    store.state.lang = "en";
    const html = renderAccountDetail({ ...acc, createdAt: 1750000000000, runtimeLinked: true });
    expect(html).toContain("my-alpaca");
    expect(html).toContain("PA3TESTNUM");
    expect(html).toContain("In use by the bot");
    expect(html.toLowerCase()).not.toContain("secret");
    expect(html).toContain("never displayed");
  });
});

describe("renderAddModal", () => {
  test("Alpaca with an OAuth app: Connect button plus the API-key alternative", () => {
    store.state.lang = "es";
    const html = renderAddModal({ configured: true, alpacaOAuth: true }, "alpaca");
    expect(html).toContain("Conectar con Alpaca");
    expect(html).toContain("data-acc-oauth");
    expect(html).toContain("claves API");
    expect(html).toContain("data-acc-save");
  });
  test("Alpaca without an OAuth app: no Connect button, keys only", () => {
    const html = renderAddModal({ configured: true, alpacaOAuth: false }, "alpaca");
    expect(html).not.toContain("data-acc-oauth");
    expect(html).toContain("data-acc-save");
  });
  test("Binance form carries the security tips (futures yes, withdrawals no, IP allowlist) and demo/live envs", () => {
    store.state.lang = "es";
    const html = renderAddModal({ configured: true, alpacaOAuth: true }, "binance_usdm");
    expect(html).toContain("FUTUROS");
    expect(html).toContain("retiros");
    expect(html).toContain("IP");
    expect(html).toContain('value="demo"');
    expect(html).toContain('value="live"');
    expect(html).not.toContain("data-acc-oauth");
  });
});
