import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandDataPath, researchDataDir, researchDataPath } from "./researchData";

const saved = process.env.UC_RESEARCH_DATA_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.UC_RESEARCH_DATA_DIR;
  else process.env.UC_RESEARCH_DATA_DIR = saved;
});

describe("research data dir", () => {
  test("defaults to ~/code/wt/data", () => {
    delete process.env.UC_RESEARCH_DATA_DIR;
    expect(researchDataDir()).toBe(join(homedir(), "code", "wt", "data"));
    expect(researchDataPath("hist-perps.db")).toBe(join(homedir(), "code", "wt", "data", "hist-perps.db"));
  });

  test("UC_RESEARCH_DATA_DIR overrides it", () => {
    process.env.UC_RESEARCH_DATA_DIR = "/srv/research";
    expect(researchDataPath("hist-intraday.db")).toBe("/srv/research/hist-intraday.db");
  });
});

describe("expandDataPath", () => {
  test("expands the manifest placeholder and ~/", () => {
    process.env.UC_RESEARCH_DATA_DIR = "/srv/research";
    expect(expandDataPath("$UC_RESEARCH_DATA_DIR/hist-perps.db")).toBe("/srv/research/hist-perps.db");
    expect(expandDataPath("~/x.db")).toBe(join(homedir(), "x.db"));
  });

  test("leaves every other path alone (the repo's ./data/historical.db manifests)", () => {
    expect(expandDataPath("./data/historical.db")).toBe("./data/historical.db");
    expect(expandDataPath("/abs/hist.db")).toBe("/abs/hist.db");
    expect(expandDataPath("$UC_RESEARCH_DATA_DIRX/a.db")).toBe("$UC_RESEARCH_DATA_DIRX/a.db");
  });
});
