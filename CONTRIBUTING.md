# Contributing

Thanks for considering a contribution to Uncle Carl Trading Bot.

## Before you start

- Read `AGENTS.md` (project structure, invariants, verification commands)
  and `docs/platform/self-hosting.md` (how to actually run an instance).
- This is a **trading** system — a bug can mean real financial loss for
  someone self-hosting it. Prefer the cautious option, and say so in your
  PR description when a change touches order placement, sizing, stop-loss
  logic, or broker reconciliation.
- `AGENTS.md` claims are only allowed to assert what's either structurally
  obvious or backed by a named test/command. If you add a claim, name the
  enforcer; if you can't, it doesn't belong there.

## Workflow

1. Fork the repo and create a branch off `master`.
2. `bun install`
3. Make your change. Favor the smallest diff that solves the problem —
   this codebase explicitly avoids speculative abstraction.
4. Add/update tests. This project tests business logic directly, not
   through the dashboard UI; a behavior change without a test is not
   considered done.
5. Verify before opening a PR:
   ```bash
   bun run typecheck   # must be clean
   bun test            # must be green (tests needing a local research DB self-skip)
   ```
6. Open a PR against `master` describing *what* changed and *why* — link
   any relevant issue. If the change affects risk/sizing/exits, say what
   you validated it against (paper run, backtest, unit tests) and what you
   didn't.

## Code style

- TypeScript strict mode, no implicit `any`.
- Bun runs `.ts` directly — there is no build step and none should be
  added without strong justification.
- No new runtime dependencies without discussing them in an issue first;
  this bot talks directly to money-moving APIs and the dependency surface
  is kept deliberately small.

## Reporting bugs / proposing features

Open a GitHub issue. For anything security-sensitive (credential handling,
auth bypass, an execution-safety bug), see `SECURITY.md` instead — please
don't file those as public issues.

## Commit messages

Prefer `type(scope): summary` (`fix(account): …`, `feat(dashboard): …`,
`docs: …`) describing the *why*, not just the *what* — the diff already
shows the what.
