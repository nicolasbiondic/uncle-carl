#!/usr/bin/env bun
// ═══ `bun run setup` — installation assistant for a self-hosted instance ═══
//
// Interactive (default, TTY):
//   bun run setup
//     → asks for dashboard port, public URL, owner username + password
//       (twice), and optionally GitHub / Google OAuth login details.
//
// Non-interactive (Docker/CI):
//   echo "$OWNER_PASSWORD" | bun run setup -- --yes \
//       --port 3789 --public-url https://bot.example.com \
//       --owner nico --password-stdin
//
// What it does (all idempotent — safe to re-run):
//   - writes <dataDir>/instance.json (mode 0600) merging over any existing
//     one; the owner password is stored as a Bun.password argon2id hash;
//   - creates <dataDir>/master.key (mode 0600) if missing — NEVER overwrites;
//   - prints the dashboard URL and the OAuth callback URLs to register.
//
// dataDir = UC_DATA_DIR env or ./data, same as the runtime
// (src/platform/instance.ts). Pure parts are exported and tested in
// scripts/setup.test.ts against a temp directory.

import readline from "node:readline/promises";
import { instanceDataDir, normalizePublicUrl, loadInstanceConfig, resetInstanceConfigForTests } from "../src/platform/instance";
import {
  readInstanceJson, mergeInstanceUpdate, writeInstanceJson, ensureMasterKey,
  validateOwnerUsername, validateOwnerPassword, hashOwnerPassword,
  dashboardBaseUrl, oauthCallbackUrls,
  type InstanceUpdate,
} from "../src/platform/instanceFile";

// ── Flag parsing (pure, tested) ────────────────────────────────────────────

export interface SetupArgs {
  yes: boolean;
  help: boolean;
  passwordStdin: boolean;
  port?: number;
  host?: string;
  publicUrl?: string;
  owner?: string;
  displayName?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubAllowedId?: number;
  githubAllowedLogin?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleAllowedEmail?: string;
}

const VALUE_FLAGS: Record<string, keyof SetupArgs> = {
  "--port": "port",
  "--host": "host",
  "--public-url": "publicUrl",
  "--owner": "owner",
  "--display-name": "displayName",
  "--github-client-id": "githubClientId",
  "--github-client-secret": "githubClientSecret",
  "--github-allowed-id": "githubAllowedId",
  "--github-allowed-login": "githubAllowedLogin",
  "--google-client-id": "googleClientId",
  "--google-client-secret": "googleClientSecret",
  "--google-allowed-email": "googleAllowedEmail",
};

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { yes: false, help: false, passwordStdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") { args.yes = true; continue; }
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a === "--password-stdin") { args.passwordStdin = true; continue; }
    const key = VALUE_FLAGS[a];
    if (!key) throw new Error(`Unknown flag: ${a} (see --help)`);
    const val = argv[++i];
    if (val === undefined) throw new Error(`Flag ${a} needs a value`);
    if (key === "port" || key === "githubAllowedId") {
      const n = parseInt(val, 10);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Flag ${a} needs a positive integer (got "${val}")`);
      if (key === "port" && n >= 65536) throw new Error(`Flag --port out of range (got ${n})`);
      (args as any)[key] = n;
    } else {
      (args as any)[key] = val;
    }
  }
  return args;
}

/** Bind address written for a NEW installation: loopback only, published
 *  through a reverse proxy or tunnel (the Wealthfolio/Hummingbot default —
 *  internet-exposed bot dashboards get scanned). An installation without
 *  instance.json keeps today's 0.0.0.0 (src/platform/instance.ts). */
export const NEW_INSTALL_HOST = "127.0.0.1";

/** F4b (pure, tested): a NEW installation (no pre-existing instance.json)
 *  reads its broker credentials from the accounts registry — accountsSource
 *  "registry" is written into the fresh instance.json. EXISTING
 *  installations are never touched: prod keeps ACCOUNTS_SOURCE unset (= env)
 *  until the owner flips it deliberately. */
export function withNewInstallAccountsSource(merged: any, isNewInstall: boolean): any {
  if (isNewInstall && merged?.accountsSource === undefined) {
    return { ...merged, accountsSource: "registry" };
  }
  return merged;
}

/** Pure: env vars that override what setup just wrote to instance.json
 *  (env > instance.json), so the owner is not surprised by a port from .env. */
export function envOverrideWarnings(written: any, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const d = written?.dashboard ?? {};
  const pairs: Array<[string, unknown]> = [["DASHBOARD_PORT", d.port], ["DASHBOARD_HOST", d.host], ["PUBLIC_URL", d.publicUrl]];
  for (const [key, value] of pairs) {
    const e = (env[key] ?? "").trim();
    if (e !== "" && value !== undefined && value !== null && String(value) !== e) {
      out.push(`${key}=${e} in the environment (.env) overrides the ${String(value)} saved in instance.json — remove it from .env to use the saved value.`);
    }
  }
  return out;
}

/** Build the InstanceUpdate for the non-interactive path (pure, tested).
 *  `passwordHash` is null when the caller didn't provide a password — the
 *  owner block is then left untouched (idempotent re-run). */
export function buildUpdateFromArgs(args: SetupArgs, passwordHash: string | null): InstanceUpdate {
  const update: InstanceUpdate = {};

  const dashboard: NonNullable<InstanceUpdate["dashboard"]> = {};
  if (args.port !== undefined) dashboard.port = args.port;
  if (args.host !== undefined) dashboard.host = args.host;
  if (args.publicUrl !== undefined) {
    if (args.publicUrl === "") dashboard.publicUrl = null;
    else {
      const normalized = normalizePublicUrl(args.publicUrl);
      if (!normalized) throw new Error(`--public-url "${args.publicUrl}" is not a valid http(s) URL`);
      dashboard.publicUrl = normalized;
    }
  }
  if (Object.keys(dashboard).length > 0) update.dashboard = dashboard;

  if (args.owner !== undefined) {
    const userErr = validateOwnerUsername(args.owner);
    if (userErr) throw new Error(userErr);
    if (!passwordHash) throw new Error("--owner requires a password (pipe it with --password-stdin)");
    update.owner = { username: args.owner, passwordHash, displayName: args.displayName };
  }

  if (args.githubClientId || args.githubClientSecret || args.githubAllowedId !== undefined) {
    if (!args.githubClientId || !args.githubClientSecret || args.githubAllowedId === undefined) {
      throw new Error("GitHub OAuth needs --github-client-id, --github-client-secret AND --github-allowed-id (numeric account id)");
    }
    update.oauth = {
      ...(update.oauth ?? {}),
      github: {
        clientId: args.githubClientId,
        clientSecret: args.githubClientSecret,
        allowedId: args.githubAllowedId,
        allowedLogin: args.githubAllowedLogin,
      },
    };
  }

  if (args.googleClientId || args.googleClientSecret || args.googleAllowedEmail) {
    if (!args.googleClientId || !args.googleClientSecret || !args.googleAllowedEmail) {
      throw new Error("Google OAuth needs --google-client-id, --google-client-secret AND --google-allowed-email");
    }
    update.oauth = {
      ...(update.oauth ?? {}),
      google: {
        clientId: args.googleClientId,
        clientSecret: args.googleClientSecret,
        allowedEmail: args.googleAllowedEmail.toLowerCase(),
      },
    };
  }

  return update;
}

// ── Interactive prompts ────────────────────────────────────────────────────

async function promptHidden(question: string): Promise<string> {
  // Raw-mode hidden input; falls back to plain readline when not a TTY.
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  }
  process.stdout.write(question);
  return await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.setRawMode?.(false);
          stdin.removeListener("data", onData);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") { // Ctrl-C
          stdin.setRawMode?.(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HELP = `bun run setup — configure this installation (idempotent; re-run anytime)

Interactive:        bun run setup
Non-interactive:    echo "$PASSWORD" | bun run setup -- --yes --owner you --password-stdin [flags]

Flags:
  --yes, -y                 non-interactive mode (no prompts)
  --port <n>                dashboard port            (default 3789)
  --host <addr>             dashboard bind host       (new install: 127.0.0.1)
  --public-url <url>        public https URL ("" to clear)
  --owner <username>        owner login username
  --password-stdin          read the owner password from stdin
  --display-name <name>     owner display name
  --github-client-id <id>   + --github-client-secret + --github-allowed-id (numeric)
  --github-allowed-login <login>   (informational)
  --google-client-id <id>   + --google-client-secret + --google-allowed-email
  --help, -h                this help

Data dir: UC_DATA_DIR env or ./data (instance.json + master.key, both 0600).`;

async function interactive(args: SetupArgs): Promise<InstanceUpdate> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const existing = readInstanceJson(instanceDataDir());
  const ask = async (q: string, def: string): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a === "" ? def : a;
  };

  console.log("── Uncle Carl self-hosted setup ──\n(Enter keeps the [default]; everything can be re-run later.)\n");

  // Dashboard
  const port = parseInt(await ask("Dashboard port", String(existing?.dashboard?.port ?? args.port ?? 3789)), 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port >= 65536) throw new Error(`Invalid port`);
  const host = await ask(
    "Listen address (127.0.0.1 = this machine only, reach it through a proxy/tunnel; 0.0.0.0 = every interface, trusted LAN only)",
    // New install → loopback; an existing instance.json without a host keeps
    // listening where it always did (re-running setup must not lock it out).
    existing?.dashboard?.host ?? args.host ?? (Object.keys(existing ?? {}).length > 0 ? "0.0.0.0" : NEW_INSTALL_HOST),
  );
  let publicUrl: string | null = null;
  while (true) {
    const raw = await ask("Public URL (empty = none, e.g. https://bot.example.com)", existing?.dashboard?.publicUrl ?? args.publicUrl ?? "");
    if (raw === "") { publicUrl = null; break; }
    publicUrl = normalizePublicUrl(raw);
    if (publicUrl) break;
    console.log("  Not a valid http(s) URL, try again.");
  }

  // Owner
  let username: string;
  while (true) {
    username = await ask("Owner username", existing?.owner?.username ?? args.owner ?? "");
    const err = validateOwnerUsername(username);
    if (!err) break;
    console.log(`  ${err}`);
  }
  const displayName = await ask("Display name", existing?.owner?.displayName ?? username);

  let passwordHash: string | null = null;
  const hasExistingOwner = Boolean(existing?.owner?.passwordHash) && existing?.owner?.username === username.toLowerCase();
  while (true) {
    const hint = hasExistingOwner ? " (empty = keep current password)" : "";
    const pw = await promptHidden(`Owner password${hint}: `);
    if (pw === "" && hasExistingOwner) { passwordHash = existing.owner.passwordHash; break; }
    const err = validateOwnerPassword(pw);
    if (err) { console.log(`  ${err}`); continue; }
    const pw2 = await promptHidden("Repeat password: ");
    if (pw !== pw2) { console.log("  Passwords do not match, try again."); continue; }
    passwordHash = await hashOwnerPassword(pw);
    break;
  }

  // OAuth (optional)
  const update: InstanceUpdate = {
    dashboard: { port, host, publicUrl },
    owner: { username, passwordHash: passwordHash!, displayName },
  };

  const wantGithub = (await ask("Configure GitHub login? (y/N)", existing?.oauth?.github ? "y" : "n")).toLowerCase().startsWith("y");
  if (wantGithub) {
    const clientId = await ask("  GitHub OAuth client id", existing?.oauth?.github?.clientId ?? "");
    const clientSecret = await ask("  GitHub OAuth client secret", existing?.oauth?.github?.clientSecret ?? "");
    const allowedId = parseInt(await ask("  Your numeric GitHub account id (https://api.github.com/users/<login>)", String(existing?.oauth?.github?.allowedId ?? "")), 10);
    const allowedLogin = await ask("  Your GitHub login (informational)", existing?.oauth?.github?.allowedLogin ?? "");
    if (!clientId || !clientSecret || !Number.isSafeInteger(allowedId) || allowedId <= 0) {
      console.log("  Incomplete GitHub config — skipping it.");
    } else {
      update.oauth = { ...(update.oauth ?? {}), github: { clientId, clientSecret, allowedId, allowedLogin: allowedLogin || undefined } };
    }
  }

  const wantGoogle = (await ask("Configure Google login? (y/N)", existing?.oauth?.google ? "y" : "n")).toLowerCase().startsWith("y");
  if (wantGoogle) {
    const clientId = await ask("  Google OAuth client id", existing?.oauth?.google?.clientId ?? "");
    const clientSecret = await ask("  Google OAuth client secret", existing?.oauth?.google?.clientSecret ?? "");
    const allowedEmail = await ask("  Allowed Google email", existing?.oauth?.google?.allowedEmail ?? "");
    if (!clientId || !clientSecret || !allowedEmail.includes("@")) {
      console.log("  Incomplete Google config — skipping it.");
    } else {
      update.oauth = { ...(update.oauth ?? {}), google: { clientId, clientSecret, allowedEmail: allowedEmail.toLowerCase() } };
    }
  }

  rl.close();
  return update;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const dataDir = instanceDataDir();
  let update: InstanceUpdate;

  if (args.yes) {
    let passwordHash: string | null = null;
    if (args.passwordStdin) {
      const pw = (await readAllStdin()).replace(/\r?\n$/, "");
      const err = validateOwnerPassword(pw);
      if (err) throw new Error(err);
      passwordHash = await hashOwnerPassword(pw);
    }
    update = buildUpdateFromArgs(args, passwordHash);
    const existing = readInstanceJson(dataDir);
    if (Object.keys(existing ?? {}).length === 0 && args.host === undefined) {
      update.dashboard = { ...(update.dashboard ?? {}), host: NEW_INSTALL_HOST };
    }
    if (!update.owner && !existing?.owner) {
      throw new Error("No owner configured yet: pass --owner <username> and pipe the password with --password-stdin");
    }
  } else {
    update = await interactive(args);
  }

  const existing = readInstanceJson(dataDir);
  const isNewInstall = Object.keys(existing ?? {}).length === 0;
  const merged = withNewInstallAccountsSource(mergeInstanceUpdate(existing, update), isNewInstall);
  const instancePath = writeInstanceJson(dataDir, merged);
  const masterKey = ensureMasterKey(dataDir);
  resetInstanceConfigForTests(); // drop any cached pre-setup view

  const ic = loadInstanceConfig();
  const base = dashboardBaseUrl(ic.dashboard.publicUrl, ic.dashboard.port);
  const callbacks = oauthCallbackUrls(ic.dashboard.publicUrl, ic.dashboard.port);

  console.log("\n── Setup complete ──");
  console.log(`  instance.json : ${instancePath} (0600)`);
  console.log(`  master.key    : ${masterKey.path} (${masterKey.created ? "created" : "kept existing"}; 0600 — back it up, losing it loses sealed secrets)`);
  console.log(`  owner         : ${merged.owner?.username ?? "(unchanged)"}`);
  console.log(`\n  Dashboard URL : ${base}`);
  console.log(`  Start it with : ./start.sh\n`);
  console.log("  OAuth callback URLs (register in the provider app settings):");
  console.log(`    GitHub : ${callbacks.github}${merged.oauth?.github ? "" : "   (not configured)"}`);
  console.log(`    Google : ${callbacks.google}${merged.oauth?.google ? "" : "   (not configured)"}`);
  if (ic.dashboard.publicUrl === null) {
    console.log("\n  NOTE: no PUBLIC_URL set — OAuth callbacks use localhost and only work from this machine.");
  }
  for (const w of envOverrideWarnings(merged, process.env)) console.log(`\n  NOTE: ${w}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`setup failed: ${e?.message ?? e}`);
    process.exit(1);
  });
}
