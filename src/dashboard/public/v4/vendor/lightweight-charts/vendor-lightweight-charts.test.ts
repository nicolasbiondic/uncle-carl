// ══════════════════════════════════════════════
// Vendored lightweight-charts (2026-10-02): the two hand-rolled SVG charts
// (equity curve, candle modal) were replaced with TradingView Lightweight
// Charts™ v5.2.1, vendored here instead of pulled from a CDN — the
// dashboard's CSP is `script-src 'self'` (src/dashboard/server.ts) and this
// file is served same-origin.
//
// This test pins the exact bytes so a future `scripts/vendor-lightweight-
// charts.sh` re-run (version bump or accidental hand-edit) is caught: the
// checksum is the one the script printed right after a real `npm pack
// lightweight-charts@5.2.1` + tar extract, not a value made up ahead of
// time. Falsifiability: editing a single byte of the vendored file fails
// "checksum matches the pinned npm release".
// ══════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DIR = import.meta.dir;
const BUNDLE = join(DIR, "lightweight-charts.standalone.production.mjs");

// sha256 of dist/lightweight-charts.standalone.production.mjs inside the
// official `npm pack lightweight-charts@5.2.1` tarball — reproduce with
// `./scripts/vendor-lightweight-charts.sh`.
const EXPECTED_SHA256 = "1bb1ee79f9d4dd17261b53d930f7a8995748276f80e7ba0e24412b5068062f5f";
const EXPECTED_VERSION = "5.2.1";

describe("vendored lightweight-charts bundle", () => {
  test("standalone production ESM build matches the pinned npm release byte-for-byte", async () => {
    expect(existsSync(BUNDLE), `missing ${BUNDLE} — run ./scripts/vendor-lightweight-charts.sh`).toBe(true);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(BUNDLE));
    expect(hasher.digest("hex")).toBe(EXPECTED_SHA256);
  });

  test("VERSION file records the pinned release", () => {
    expect(readFileSync(join(DIR, "VERSION"), "utf8").trim()).toBe(EXPECTED_VERSION);
  });

  test("license header in the bundle itself names the version and Apache-2.0", () => {
    const head = readFileSync(BUNDLE, "utf8").slice(0, 400);
    expect(head).toContain(`v${EXPECTED_VERSION}`);
    expect(head).toContain("Apache License 2.0");
    expect(head).toContain("TradingView");
  });

  test("LICENSE file is the Apache License 2.0", () => {
    const lic = readFileSync(join(DIR, "LICENSE"), "utf8");
    expect(lic).toContain("Apache License");
    expect(lic).toContain("Version 2.0");
  });

  // Apache-2.0 §4(d): a NOTICE file's attribution must be carried forward.
  // TradingView's license terms additionally require naming TradingView as
  // the product creator — satisfied here by shipping NOTICE verbatim AND by
  // leaving the library's default `attributionLogo: true` on every chart we
  // create (equity.js / candle.js never set it to false), which renders a
  // TradingView link on the chart itself per the library's own docs.
  test("NOTICE attributes TradingView as the creator", () => {
    const notice = readFileSync(join(DIR, "NOTICE"), "utf8");
    expect(notice).toContain("TradingView Lightweight Charts");
    expect(notice).toContain("tradingview.com");
  });
});
