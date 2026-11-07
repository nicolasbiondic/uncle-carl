// Weekly restore drill (audit F-9): the real restore-db.sh restores the newest
// backup into a temp dir, and the registry opens with the BACKED-UP key.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretBox } from "../src/platform/secretBox";
import { runRestoreDrill } from "./restore-drill";

const SCRIPT = join(import.meta.dir, "restore-drill.sh");
let dir: string;
let backups: string;
let key: Buffer;

function keyFile(k: Buffer): string {
  const text = k.toString("base64") + "\n";
  const name = `master-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.key`;
  writeFileSync(join(backups, name), text, { mode: 0o600 });
  return name;
}

function makeBackup(date: string, opts: { snapshotAgeH?: number; sealWith?: Buffer; trades?: number } = {}) {
  const path = join(backups, `daily-${date}.db`);
  const db = new Database(path);
  db.exec(`CREATE TABLE trades (id TEXT); CREATE TABLE equity_snapshots (snapshot_time INTEGER);
    CREATE TABLE platform_broker_accounts (id TEXT, credentials_enc TEXT NOT NULL);`);
  for (let i = 0; i < (opts.trades ?? 3); i++) db.query("INSERT INTO trades VALUES (?)").run(`t${i}`);
  db.query("INSERT INTO equity_snapshots VALUES (?)").run(Date.now() - (opts.snapshotAgeH ?? 2) * 3_600_000);
  const box = createSecretBox(opts.sealWith ?? key);
  db.query("INSERT INTO platform_broker_accounts VALUES (?,?)").run("alpaca-paper", box.seal(JSON.stringify({ apiKey: "PKFIXTURE", secret: "s" })));
  db.query("INSERT INTO platform_broker_accounts VALUES (?,?)").run("revoked", "");
  db.close();
  return path;
}

async function drill(extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bash", SCRIPT], {
    env: {
      ...process.env, DRILL_BACKUP_DIR: backups, BUN_BIN: process.execPath,
      CRON_MARKER_DIR: join(dir, "markers"), CRON_ENV_FILE: join(dir, "no.env"), TMPDIR: join(dir, "tmp"), ...extra,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restore-drill-"));
  backups = join(dir, "backups");
  mkdirSync(backups); mkdirSync(join(dir, "tmp"));
  key = randomBytes(32);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("restore-drill.sh (real restore-db.sh into a temp dir)", () => {
  test("restores the NEWEST daily backup, opens the registry with the backed-up key, marks success, cleans up", async () => {
    keyFile(key);
    const old = makeBackup("20261101", { snapshotAgeH: 200 }); // stale: must not be the one picked
    utimesSync(old, new Date(), new Date());                  // even when it is the newest by mtime
    makeBackup("20261106");
    const r = await drill();
    expect(r.code).toBe(0);
    expect(r.out).toContain("restoring daily-20261106.db");
    expect(r.out).toContain("integrity_check=ok");
    expect(r.out).toMatch(/registry: 1\/1 account\(s\) decrypted with master-[0-9a-f]{12}\.key/);
    expect(r.out).toContain("PASSED");
    expect(r.out + r.err).not.toContain("PKFIXTURE");
    expect(existsSync(join(dir, "markers", "restore-drill.ok"))).toBe(true);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]); // temp restore dir removed
  }, 30_000);

  test("a key that does not open the registry FAILS the drill (exit 1, no marker, page attempted)", async () => {
    keyFile(randomBytes(32));
    makeBackup("20261106");
    const r = await drill();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL account alpaca-paper: no backed-up key opens its credentials");
    expect(r.err).toContain("DROPPED"); // no credentials in the fixture: the page is dropped loudly
    expect(existsSync(join(dir, "markers", "restore-drill.ok"))).toBe(false);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  }, 30_000);

  test("no backup at all fails loudly", async () => {
    const r = await drill();
    expect(r.code).toBe(1);
    expect(r.err).toContain("no daily-YYYYMMDD.db");
  });

  test("a corrupt backup aborts in restore-db.sh's integrity gate", async () => {
    keyFile(key);
    writeFileSync(join(backups, "daily-20261106.db"), "this is not sqlite");
    const r = await drill();
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "markers", "restore-drill.ok"))).toBe(false);
  }, 30_000);
});

describe("runRestoreDrill checks", () => {
  function restored(opts: Parameters<typeof makeBackup>[1] = {}) {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const src = makeBackup("20261106", opts);
    writeFileSync(join(data, "trading.db"), readFileSync(src));
    return data;
  }
  test("a stale backup (newest equity snapshot older than the limit) fails", () => {
    keyFile(key);
    const r = runRestoreDrill({ dataDir: restored({ snapshotAgeH: 30 }), keysDir: backups, maxAgeHours: 26 });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("the backup is stale");
  });
  test("an empty book fails; sealed accounts without any backed-up key fail", () => {
    const r = runRestoreDrill({ dataDir: restored({ trades: 0 }), keysDir: backups });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("trades is empty");
    expect(r.lines.join("\n")).toContain("no backed-up master-<sha12>.key");
  });
  test("restored risk-state JSON must parse", () => {
    keyFile(key);
    const data = restored();
    writeFileSync(join(data, "momentum-state-crypto.json"), "{broken");
    const r = runRestoreDrill({ dataDir: data, keysDir: backups });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("momentum-state-crypto.json is not valid JSON");
  });
});

describe("backup-db.sh keeps versioned keys and ISO weeks", () => {
  const src = readFileSync(join(import.meta.dir, "backup-db.sh"), "utf8");
  test("master key: content-addressed master-<sha12>.key, never the overwritten master.key, shipped off-host", () => {
    expect(src).toContain('KEY_COPY="$BACKUP_DIR/master-${KEY_HASH}.key"');
    expect(src).toContain('ship "$KEY_COPY" 600');
    expect(src).not.toContain('ship "$DATA_DIR/master.key"');
  });
  test("weekly names use the ISO week-numbering year (%G), never %Y with %V", () => {
    expect(src).not.toMatch(/%Y-W%V/);
    expect(src.match(/%G-W%V/g)?.length).toBe(3);
  });
  test("an off-host copy that did not land fails the job (exit 3) after the local backup", () => {
    expect(src).toMatch(/OFFHOST_FAILED=1/);
    expect(src).toContain("exit 3");
  });
});
