// ══════════════════════════════════════════════
// Supervision invariants — "the bot must always be running"
//
// Every assertion here exists because the 2026-08-06 availability audit
// found the chain broken in a specific place. These are cheap static
// checks on the supervision artifacts themselves: they cannot prove the
// bot stays up, but they DO fail the moment someone reintroduces one of
// the three holes that were actually found.
//
// The chain, and what covers each link:
//   process crashes        → systemd Restart=always (§1)
//   process exits cleanly  → systemd Restart=always (§1) ← the hole
//   crash-loops            → watchdog + reset-failed (§2) ← the hole
//   process hangs          → /healthz 503 on stale critical loop (§3)
//   nothing polls healthz  → watchdog cron installed (§2) ← the hole
//   host reboots           → unit enabled + lingering (operational, §4)
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const unit = readFileSync(join(ROOT, "scripts", "uncle-carl.service"), "utf8");
const watchdog = readFileSync(join(ROOT, "scripts", "watchdog.sh"), "utf8");
const installCron = readFileSync(join(ROOT, "scripts", "install-cron.sh"), "utf8");
const health = readFileSync(join(ROOT, "src", "dashboard", "routes", "health.ts"), "utf8");

/** Strip shell/ini comments: these files document past incidents in prose,
 *  so a naive grep matches the very words the invariant forbids. Asserting
 *  on executable lines only is the difference between testing the code and
 *  testing the changelog. */
const code = (src: string) =>
  src.split("\n").filter(l => !l.trim().startsWith("#")).join("\n");

describe("§1 systemd restarts the bot from ANY exit, not just failures", () => {
  test("Restart=always — a clean exit(0) must not leave the bot down", () => {
    // Was Restart=on-failure until 2026-08-06: systemd treated a clean exit
    // as a correct outcome and left a bot with open positions stopped.
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).not.toMatch(/^Restart=on-failure$/m);
  });

  test("a restart delay exists, so a crash loop throttles instead of spinning", () => {
    expect(unit).toMatch(/^RestartSec=\d+/m);
  });

  test("the start limit lives in [Unit], where systemd actually reads it", () => {
    // systemd silently ignores StartLimit* under [Service]; a silently
    // ignored throttle is worse than none, because it reads as protection.
    const c = code(unit);
    const unitSection = c.slice(c.indexOf("[Unit]"), c.indexOf("[Service]"));
    expect(unitSection).toMatch(/StartLimitIntervalSec=/);
    expect(unitSection).toMatch(/StartLimitBurst=/);
  });
});

describe("§2 the watchdog is installed, and can recover the crash-loop case", () => {
  test("install-cron.sh installs the watchdog (prod ran an older copy that did not)", () => {
    // The 2026-08-06 audit found prod's crontab carried the backup and the
    // historical refresh but NOT the watchdog: prod had been provisioned by
    // a version of this script that predated it, and nothing re-ran it.
    expect(installCron).toMatch(/watchdog\.sh/);
    expect(installCron).toMatch(/uncle-carl-watchdog/);
  });

  test("the watchdog clears a FAILED unit before restarting it", () => {
    // A unit that tripped StartLimitBurst sits in `failed` and systemd
    // refuses `start` ("start request repeated too quickly") until the
    // counter is reset. Without this, the crash loop is precisely the case
    // the watchdog cannot recover — the opposite of its purpose.
    const c = code(watchdog);
    expect(c).toMatch(/is-failed/);
    expect(c).toMatch(/reset-failed/);
    // …and it must do so BEFORE handing over to start.sh (executable lines
    // only: the header prose mentions start.sh long before either).
    expect(c.indexOf("reset-failed")).toBeLessThan(c.indexOf('"$ROOT_DIR/start.sh"'));
  });

  test("the watchdog restarts through start.sh, never a raw nohup", () => {
    // AGENTS.md pitfall #7: bypassing start.sh skips systemd supervision,
    // log capture and resource limits, and can orphan a process outside the
    // unit's cgroup — the 2026-07-27 zombie-deploy incident.
    const c = code(watchdog);
    expect(c).toMatch(/start\.sh/);
    expect(c).not.toMatch(/nohup|setsid/);
  });

  test("the watchdog exports the session bus, or cron's systemctl silently fails", () => {
    // Verified live on 2026-07-27: without these, `systemctl --user` under
    // cron returns "Failed to connect to bus" and every watchdog restart
    // fell through to the fallback path, spawning orphans.
    expect(watchdog).toMatch(/XDG_RUNTIME_DIR/);
    expect(watchdog).toMatch(/DBUS_SESSION_BUS_ADDRESS/);
  });

  test("overlapping watchdog ticks cannot fight each other", () => {
    expect(watchdog).toMatch(/flock/);
  });

  test("the anti-storm guards of 2026-09-11 stay wired: 2 consecutive DOWN ticks, 10min restart cooldown, 15s probe timeout", () => {
    // The 83-restart class: the old script restarted on the FIRST failed
    // curl with a 5s timeout, and /healthz used to 503 on a merely-stale
    // loop — five restarts in 20 minutes during the 09-11 Alpaca 504 storm,
    // each killing a live process. These three guards + the liveness
    // semantics in routes/health.ts are the fix; removing any one of them
    // reintroduces the feedback loop.
    const c = code(watchdog);
    expect(c).toMatch(/DOWN_TICKS_REQUIRED="\$\{WATCHDOG_DOWN_TICKS:-2\}"/);
    expect(c).toMatch(/RESTART_COOLDOWN_S="\$\{WATCHDOG_RESTART_COOLDOWN_S:-600\}"/);
    expect(c).toMatch(/curl -fsS -m 15/);
  });

  test("broker outage ≠ dead bot: the watchdog's ONLY probe is /healthz, which stays 200 for loops alive against an unreachable broker", () => {
    // 2026-09-23 07:45: Alpaca's API was down, the sync loops were alive
    // (completing failed passes), /healthz went 503 and this script
    // restarted a healthy process into "DEGRADED START — alpaca DOWN".
    // The fix lives at the SOURCE (heartbeats.beatFailed keeps liveness →
    // /healthz 200 "degraded" + broker_unreachable_count; see
    // routes/health.test.ts "broker unreachable ≠ dead loop"). This side
    // only needs to keep relying on /healthz's status code and add no
    // probe of its own that could re-learn the wrong lesson.
    const c = code(watchdog);
    expect(c).toMatch(/healthz/);
    expect(c).not.toMatch(/healthz\/full/); // liveness only — never readiness
    expect(health).toMatch(/beatFailed|broker_unreachable/); // the source-side fix exists
  });
});

describe("§3 a hung bot is detectable — healthz is not merely 'process alive'", () => {
  test("/healthz returns 503 when a CRITICAL loop goes stale", () => {
    // This is what makes the watchdog able to catch a hang and not just a
    // dead process: the HTTP server can be perfectly alive while the
    // trading loops are frozen (the 31h freeze of 2026-07).
    expect(health).toMatch(/staleCritical/);
    expect(health).toMatch(/503/);
  });

  test("shadow and non-trading loops cannot trigger a restart", () => {
    // A zero-capital shadow book going quiet must never bounce a live bot.
    expect(health).toMatch(/shadow_/);
    expect(health).toMatch(/funding_monitor/);
  });
});

describe("§4 the supervision chain is documented where an operator will look", () => {
  test("the unit is installed enabled, so a host reboot brings the bot back", () => {
    const installSystemd = readFileSync(join(ROOT, "scripts", "install-systemd.sh"), "utf8");
    expect(installSystemd).toMatch(/enable/);
    // Lingering is what lets a --user unit start without an active login.
    expect(installSystemd).toMatch(/linger/i);
  });
});

describe("§5 nothing an operator routinely creates may block the deploy pipeline", () => {
  test(".gitignore covers .env* and *.bak-* (a backup blocked deploys for 2h on 2026-08-07)", () => {
    // auto-deploy refuses to touch a dirty tree — correctly. So the files an
    // operator creates as a matter of good hygiene (cp .env .env.bak-<ts>
    // before editing) must never be able to make it dirty.
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env\*$/m);
    expect(gitignore).toMatch(/^\*\.bak-\*$/m);
    // …and .env.example must still ship, or a fresh clone has no template.
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });

  test("a persistently dirty tree pages instead of skipping silently", () => {
    const deploy = readFileSync(join(ROOT, "scripts", "auto-deploy.sh"), "utf8");
    const code = deploy.split("\n").filter(l => !l.trim().startsWith("#")).join("\n");
    expect(code).toMatch(/DIRTY_PAGE_AFTER_SEC/);
    // The page must go through notify(), which targets the OPS chat only.
    const dirtyBlock = code.slice(code.indexOf("working tree dirty"), code.indexOf("working tree dirty") + 900);
    expect(dirtyBlock).toMatch(/notify /);
    // And the refusal itself must remain — pinging is not permission to clobber.
    expect(dirtyBlock).toMatch(/exit 0/);
  });
});
