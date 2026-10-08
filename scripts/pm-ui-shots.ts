#!/usr/bin/env bun
// ── pm-ui-shots.ts — Playwright screenshot sweep over the visual harness ──
// Usage: start the harness first:
//   bun run scripts/dashboard-visual-harness.ts   (LWC_FIXTURES_DIR=<dir> for chart fixtures)
// then:
//   bun run scripts/pm-ui-shots.ts [--only page1,page2] [--base http://localhost:4173]
// Shots land in $PM_UI_SHOTS_DIR (default ./reports/pm-ui-shots/, gitignored).
// Chromium: $PLAYWRIGHT_CHROMIUM, else Playwright's cached build.
import { chromium } from "playwright-core";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:4173";
const OUT = process.env.PM_UI_SHOTS_DIR || join(process.cwd(), "reports", "pm-ui-shots");
const EXE = process.env.PLAYWRIGHT_CHROMIUM || join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",")
  : null;

// page name → { hash, prep } — prep runs in the page after load.
const PAGES: Record<string, { hash: string; prep?: (page: any) => Promise<void> }> = {
  resumen:     { hash: "#/resumen" },
  performance: { hash: "#/resumen", prep: async (p) => { await p.click('[data-atab="performance"]').catch(() => {}); await p.waitForTimeout(700); } },
  portafolios: { hash: "#/portafolios" },
  cuentas:     { hash: "#/cuentas" },
  actividad:   { hash: "#/actividad" },
  ajustes:     { hash: "#/ajustes" },
};

const VIEWPORTS = [{ w: 1769, h: 950 }, { w: 390, h: 844 }];
const THEMES = ["dark", "light"];
const LANGS = ["en", "es"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const lang of LANGS) {
          const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
          const page = await ctx.newPage();
          await page.addInitScript(`
            localStorage.setItem("uc4_theme", ${JSON.stringify(JSON.stringify(theme))});
            localStorage.setItem("uc4_lang", ${JSON.stringify(JSON.stringify(lang))});
            localStorage.setItem("uc4_newsShown", "true");
            localStorage.setItem("uc4_tab", '"equity"');
          `);
          for (const [name, def] of Object.entries(PAGES)) {
            if (only && !only.includes(name)) continue;
            await page.goto(`${BASE}/${def.hash}`, { waitUntil: "networkidle" }).catch(async () => {
              await page.goto(`${BASE}/${def.hash}`, { waitUntil: "load" });
            });
            await page.waitForTimeout(900);
            if (def.prep) await def.prep(page);
            const file = `${name}-${theme}-${lang}-${vp.w}x${vp.h}.png`;
            await page.screenshot({ path: join(OUT, file), fullPage: vp.w < 500 });
            console.log("✓", file);
          }
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
