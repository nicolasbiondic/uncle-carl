// ── F3c — pure render helpers of the read-only Portfolios view.
// DOM-less: only the html-string builders and the label/band mappings,
// in both languages (t() reads store.state.lang).
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { esc } from "../ui.js";
import {
  templateLabel,
  accountLabel,
  bandChipHtml,
  portfolioRowHtml,
  renderPortfoliosBody,
  parseParamsJson,
  buildCreateBody,
  buildPatchBody,
  formatErrors,
  exampleParamsFor,
  renderEditFormHtml,
} from "./portfolios.js";

const originalLang = store.state.lang;
afterEach(() => { store.state.lang = originalLang; });

const P = {
  id: "momentum_stocks",
  name: "Momentum TSM daily — Alpaca stocks/ETFs",
  template: "momentum_tsm",
  account: "alpaca_main",
  capital: 50_000,
  universeSize: 11,
  mode: "live",
  enabled: true,
  status: "active",
  validation: "validated",
  rowSource: "builtin",
  origin: "code",
  band: { status: "within", liveCumReturnPct: 2.4, p5Pct: -1.1, reason: null },
};

describe("labels (bilingual via t())", () => {
  test("template labels in English and Spanish", () => {
    store.state.lang = "en";
    expect(templateLabel("meanrev_connors")).toBe("Mean reversion (Connors RSI2)");
    store.state.lang = "es";
    expect(templateLabel("meanrev_connors")).toBe("Reversión a la media (Connors RSI2)");
    expect(templateLabel("momentum_tsm")).toBe("Momentum TSM");
    expect(templateLabel("custom_x")).toBe("custom_x"); // unknown passes through
  });
  test("account labels map the four runtime accounts", () => {
    expect(accountLabel("alpaca_main")).toBe("Alpaca");
    expect(accountLabel("binance_usdt")).toBe("Binance USDT-M");
    expect(accountLabel("binance_usdc")).toBe("Binance USDC-M");
    expect(accountLabel("binance_coinm")).toBe("Binance COIN-M");
    expect(accountLabel("other")).toBe("other");
  });
});

describe("bandChipHtml", () => {
  test("no band / unavailable → honest dash, never a fabricated ok", () => {
    expect(bandChipHtml(null)).toContain("—");
    expect(bandChipHtml({ status: "unavailable" })).toContain("—");
  });
  test("below is red (var(--down)) with the live vs p5 detail", () => {
    store.state.lang = "en";
    const html = bandChipHtml({ status: "below", liveCumReturnPct: -3.25, p5Pct: -1.1 });
    expect(html).toContain("var(--down)");
    expect(html).toContain("Below band");
    expect(html).toContain("-3.3% vs p5 -1.1%"); // live vs p5 detail, num(…, 1)
  });
  test("within/above are green; insufficient_data is muted and translated", () => {
    store.state.lang = "es";
    expect(bandChipHtml({ status: "within" })).toContain("En banda");
    expect(bandChipHtml({ status: "above" })).toContain("var(--up)");
    expect(bandChipHtml({ status: "insufficient_data" })).toContain("Muy nuevo");
  });
});

describe("portfolioRowHtml", () => {
  test("carries every read-API field the spec lists", () => {
    store.state.lang = "en";
    const html = portfolioRowHtml(P);
    expect(html).toContain("Momentum TSM daily — Alpaca stocks/ETFs");
    expect(html).toContain("momentum_stocks");
    expect(html).toContain("Alpaca");
    expect(html).toContain("$50,000");
    expect(html).toContain("<td>11</td>");
    expect(html).toContain("live");
    expect(html).toContain("Within band");
  });
  test("disabled, pending_restart and unvalidated states are visible", () => {
    store.state.lang = "es";
    const html = portfolioRowHtml({ ...P, enabled: false, status: "pending_restart", validation: "unvalidated" });
    expect(html).toContain("desactivado");
    expect(html).toContain("pendiente de reinicio");
    expect(html).toContain("no validado");
  });
});

describe("renderPortfoliosBody", () => {
  test("null (route not mounted) and empty list degrade honestly", () => {
    store.state.lang = "en";
    expect(renderPortfoliosBody(null)).toContain("route not mounted");
    expect(renderPortfoliosBody([])).toContain("No portfolios");
  });
  test("declares the running source (code vs db) above the table", () => {
    store.state.lang = "en";
    expect(renderPortfoliosBody([P])).toContain("PORTFOLIOS_SOURCE=code");
    expect(renderPortfoliosBody([{ ...P, origin: "db" }])).toContain("PORTFOLIOS_SOURCE=db");
  });
  test("not writable: no New-portfolio button, no Actions column, shows the unlock note", () => {
    store.state.lang = "en";
    const html = renderPortfoliosBody([P], { writable: false, presets: [], accounts: [] });
    expect(html).not.toContain("data-pf-new");
    expect(html).not.toContain("data-pf-edit=");
    expect(html).toContain("PORTFOLIOS_SOURCE=db");
  });
  test("writable: New-portfolio button and per-row Edit/Archive controls appear", () => {
    store.state.lang = "en";
    const html = renderPortfoliosBody([P], { writable: true, presets: [], accounts: ["alpaca_main"] });
    expect(html).toContain("data-pf-new");
    expect(html).toContain(`data-pf-edit="${P.id}"`);
    expect(html).toContain(`data-pf-archive="${P.id}"`);
    expect(html).toContain("Archive");
    const archivedHtml = renderPortfoliosBody([{ ...P, status: "archived" }], { writable: true, presets: [], accounts: [] });
    expect(archivedHtml).toContain("Restore");
  });
});

describe("parseParamsJson", () => {
  test("empty/blank text parses to {ok:true, value:undefined}", () => {
    expect(parseParamsJson("")).toEqual({ ok: true, value: undefined });
    expect(parseParamsJson("   ")).toEqual({ ok: true, value: undefined });
  });
  test("valid object JSON parses through", () => {
    expect(parseParamsJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  test("invalid JSON produces a clear, bilingual error (never a raw stack)", () => {
    store.state.lang = "en";
    const bad = parseParamsJson("{not json");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Invalid params JSON");
    store.state.lang = "es";
    expect(parseParamsJson("{not json").error).toContain("JSON de params inválido");
  });
  test("a JSON array or primitive is rejected — params must be an object", () => {
    store.state.lang = "en";
    expect(parseParamsJson("[1,2,3]").ok).toBe(false);
    expect(parseParamsJson("42").ok).toBe(false);
  });
});

describe("buildCreateBody", () => {
  test("missing required fields are listed as errors", () => {
    const r = buildCreateBody({ source: "preset" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  test("preset path: body carries id/name/account/capital/preset, no params", () => {
    const r = buildCreateBody({ source: "preset", id: "momentum_stocks_v2", name: "Stocks v2", account: "alpaca_main", capital: "1000", preset: "momentum_stocks" });
    expect(r).toEqual({ ok: true, body: { id: "momentum_stocks_v2", name: "Stocks v2", account: "alpaca_main", capital: 1000, preset: "momentum_stocks" } });
  });
  test("free template path: requires a valid template and parseable object params", () => {
    const bad = buildCreateBody({ source: "free", id: "x", name: "X", account: "alpaca_main", capital: "1", template: "momentum_tsm", paramsText: "{bad" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("Invalid params JSON");

    const ok = buildCreateBody({ source: "free", id: "x", name: "X", account: "alpaca_main", capital: "1", template: "momentum_tsm", paramsText: '{"maxLongs":1}' });
    expect(ok).toEqual({ ok: true, body: { id: "x", name: "X", account: "alpaca_main", capital: 1, template: "momentum_tsm", params: { maxLongs: 1 } } });
  });
  test("free template with empty params is refused (params required)", () => {
    const r = buildCreateBody({ source: "free", id: "x", name: "X", account: "alpaca_main", capital: "1", template: "momentum_tsm", paramsText: "" });
    expect(r.ok).toBe(false);
  });
});

describe("buildPatchBody", () => {
  test("name/capital/enabled always included; no params key when the textarea is empty", () => {
    const r = buildPatchBody({ name: "New name", capital: "2000", enabled: true, paramsText: "" });
    expect(r).toEqual({ ok: true, body: { name: "New name", capital: 2000, enabled: true } });
  });
  test("params included (parsed) when the textarea is non-empty", () => {
    const r = buildPatchBody({ name: "X", capital: "1", enabled: false, paramsText: '{"a":1}' });
    expect(r).toEqual({ ok: true, body: { name: "X", capital: 1, enabled: false, params: { a: 1 } } });
  });
  test("invalid params JSON surfaces a clear error and blocks the save", () => {
    const r = buildPatchBody({ name: "X", capital: "1", enabled: true, paramsText: "{oops" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("Invalid params JSON");
  });
  test("blank name or non-positive capital are refused", () => {
    expect(buildPatchBody({ name: "", capital: "1", enabled: true }).ok).toBe(false);
    expect(buildPatchBody({ name: "X", capital: "0", enabled: true }).ok).toBe(false);
  });
});

describe("formatErrors", () => {
  test("empty/undefined -> empty string", () => {
    expect(formatErrors([])).toBe("");
    expect(formatErrors(undefined)).toBe("");
  });
  test("renders the API's errors verbatim, as an escaped list — never reworded", () => {
    const html = formatErrors(["capital: must be a number > 0", "id '<bad>' already exists"]);
    expect(html).toContain("<li>capital: must be a number &gt; 0</li>");
    expect(html).toContain("&lt;bad&gt;");
  });
});

describe("renderEditFormHtml", () => {
  test("prefills the advanced-params textarea with the row's CURRENT params (GET now ships them)", () => {
    const p = { ...P, params: { maxLongs: 8, universe: ["SPY", "QQQ"] } };
    const html = renderEditFormHtml(p, {});
    expect(html).toContain(esc(JSON.stringify(p.params, null, 2)));
    expect(html).toContain('value="Momentum TSM daily — Alpaca stocks/ETFs"');
    expect(html).toContain("checked"); // P.enabled === true
  });
  test("in-progress edit state (unsaved textarea) wins over the row's params", () => {
    const p = { ...P, params: { maxLongs: 8 } };
    const html = renderEditFormHtml(p, { paramsText: '{"maxLongs":9}' });
    expect(html).toContain(esc('{"maxLongs":9}'));
  });
});

describe("exampleParamsFor", () => {
  const presets = [
    { id: "momentum_stocks", template: "momentum_tsm", exampleParams: { maxLongs: 8 } },
    { id: "meanrev_stocks", template: "meanrev_connors", exampleParams: { heartbeatName: "meanrev:stocks" } },
  ];
  test("picks the preset sharing the requested template", () => {
    expect(exampleParamsFor(presets, "momentum_tsm")).toEqual({ maxLongs: 8 });
    expect(exampleParamsFor(presets, "meanrev_connors")).toEqual({ heartbeatName: "meanrev:stocks" });
  });
  test("no match -> {} (never undefined, so JSON.stringify never breaks)", () => {
    expect(exampleParamsFor(presets, "unknown")).toEqual({});
    expect(exampleParamsFor([], "momentum_tsm")).toEqual({});
  });
});
