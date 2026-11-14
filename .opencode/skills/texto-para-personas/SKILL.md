---
name: texto-para-personas
description: Rules for every text and number the owner reads in Uncle Carl (dashboard, Telegram alerts, /status, /profits, daily digest, reports to the owner). Use before adding or changing any owner-facing label, table, chip, tooltip, alert or message, and when reviewing one. Covers plain words instead of codes, the three money concepts, whole dollars, ticker names, no sideways scroll, and the checks to run before shipping.
---

# Text for people

The owner's rule (2026-11-12): "lo va a ver una persona, no una máquina". The
reader is the owner: not a trader, not a programmer, reads in Spanish, looks at
the dashboard on a laptop and at Telegram on a phone. If he has to ask what a
word, a code or a number means, the text is wrong, even when it is correct.

This skill is about presentation only. It never changes a money formula, a
model or an order. If a text cannot be made clear without a new figure, stop
and ask.

## 1. Money: three concepts, one name each

Every money figure has one reader (`src/portfolio/money.ts`,
`src/portfolio/truth.ts`). Format the reader's result; never recompute it on a
screen.

| Concept | What it is | How it reads |
|---|---|---|
| GANANCIA | Change in the account's value over a period. The only figure that may be called "hoy". | Dashboard `Ganancia hoy` / `Gain today`; Telegram `Hoy −$39 (−0,0 %)` |
| REALIZADO | Net result of what was closed, counted since each position was opened. Never today's gain. | `Cerradas hoy: 12 operaciones, +$391 en total (desde que se abrieron)` |
| SIN CERRAR | Result of the open positions since they were opened. | Dashboard column `Sin cerrar` / `Open (since entry)`; Telegram `Siguen abiertas: 49 posiciones, +$607 desde que se abrieron` |

- The labels live in `MONEY_LABELS` (`src/portfolio/money.ts`). Use the same
  word on the dashboard and in Telegram; do not invent a fourth name.
- A figure that is unknown reads as unknown ("—", "sin dato"), never as $0.
- New money surface: add it to `src/portfolio/moneyConsistency.test.ts`, not a
  new formula.

## 2. Numbers

- Whole dollars. No cents in tables, tiles, chips or Telegram (`$118,417`,
  `+$665`). Dashboard helpers: `moneyCompact`, `pnlWhole`, `pctWhole` in
  `src/dashboard/public/v4/js/fmt.js`; a positive amount under a dollar reads
  `<$1`.
- Whole percentages in tables. No decimals the owner did not ask for.
- Always a sign on a result (`+` or `−`, the real minus sign), and a word or a
  sign next to every colour: red or green is never the only signal.
- No "×" notation for exposure or leverage. Write it in words: "invertido el
  88 % de su capital · límite 250 %", not "0.88× of 2.5×". The only "×"
  allowed is inside a product name ("S&P 500 ×2").
- Dates and times say what they are: New York time is named, a missing time is
  a dash.

## 3. Words

- No internal codes, column abbreviations or jargon on screen: no `SYM`, `S`,
  `L`, `MtM`, `fills`, `display`, `notional`, `sleeve`, `DD`, `vt45`, close
  codes like `MAX_HOLD`. Telegram texts are tested against a short banned list
  (`fills`, `MtM`, `display`, cents); the rest is on you.
- Every close reason goes through `closeReasonWord`
  (`src/dashboard/public/v4/js/close-reasons.js`), shared by the dashboard and
  Telegram. A new close code needs words in both languages there.
- Every ticker carries a plain name: use `symbolCell` / `symbolLabel`
  (`src/dashboard/public/v4/js/symbol-cell.js`), names in
  `src/dashboard/public/v4/js/symbol-names.js`. Adding a symbol to a live
  universe without a name fails the build. "USD" is a semiconductors ETF, not
  dollars: never print a bare code.
- One name per strategy everywhere: `portfolioName` in
  `src/dashboard/public/v4/js/store.js`.
- Long is the normal case and says nothing. A short carries the word "corto"
  / "short" with the explanation "Gana si el precio baja".
- Sentence case. No ALL-CAPS labels.
- A row, a header or a chip should read as a sentence: "Momentum Acciones ·
  11 posiciones · $43,677 · sin cerrar −$436 · 4 ganan, 7 pierden".
- Both languages through `t(en, es)` on the dashboard. Telegram and reports to
  the owner are in Spanish.

## 4. Layout

- One view (owner, 2026-11-14: "tengo que poder verlo en una sola vista"). What
  the owner opens the screen for fits on one screen: no scrolling inside a
  card to find the fourth strategy. If it does not fit, show the few that
  matter and one "see all" line that goes to a detail page; do not add a
  scrollbar. Only a log (trades, actions) may scroll.
- Columns, not only rows (same day: "acostúmbrate a utilizar columnas en vez de
  solo filas"). Things of the same kind (the strategies, the brokers) go side
  by side, one column each, so they can be compared at a glance; a stack of
  full-width rows that each use half their width is the pattern to avoid.
- The Overview is the model (`src/dashboard/public/v4/js/components/board.js`):
  one column per strategy, each telling its whole story top to bottom (value,
  30-day change, curve, positions as bars in dollars, what the bot is doing),
  nothing scrolls, "… N more · see all" goes to the Detail page. Tables and
  logs live on Detail.
- A chart before a table, and one figure clearly bigger than the rest: the
  reader must know where to look first. Decorating a table with small bars was
  rejected twice ("no se ve visual, no lo entiendo"): a bar or a gauge he has
  to decode is noise, and percentages of capital ("145 % of its capital ·
  limit 250 %") told him nothing. Say it in dollars.
- No sideways scroll. When space runs out, hide the least important text first
  (`src/dashboard/public/v4/js/fit.js`) and keep the full text in the tooltip;
  do not shrink the font or let the row overflow. On a computer (981 px and
  wider) this is checked. On the phone the tables and the summary strip still
  scroll sideways (an open owner decision), so do not make it worse and do not
  claim a phone screen is free of it without looking.
- One clear visual per row (the diverging result bar, the five-segment time
  bar). Bars are `aria-hidden`; the text carries the meaning.
- Keep the design system: the tokens in `src/dashboard/public/v4/css/tokens.css`,
  the current fonts and colours. No font swap, gradients, glass effects or new
  dependencies unless the owner asks for a redesign.

## 5. Design skills

For work bigger than a label, load the matching global skill and give it this
brief: an existing product used to operate and read, refinement only, design
system kept, the rules above win over the skill's taste.

- `critique`: review a screen before changing it.
- `clarify`: rewrite confusing labels, messages and errors.
- `distill`: remove what the owner does not need.
- `adapt`: make a screen work on the phone.
- `impeccable`: the base the three above ask for.

## 6. Before shipping

1. Read the text aloud as the owner. Would he need to ask anything?
2. Run the targeted tests:
   `bun test src/dashboard src/telegram src/portfolio/moneyConsistency.test.ts`
   and `bun run typecheck`.
3. Dashboard change: `bun run dashboard:check --out /tmp/opencode/dash-check`,
   then open and read the screenshots yourself (1280 wide in Spanish, the
   widest, and 390 wide). Passing geometry is not proof that it reads well.
   Leave no browser process behind.
4. Telegram change: print the real texts
   (`PLAIN_MONEY_EXAMPLES=1 bun test src/telegram/plain-money.test.ts`) and
   read them.
5. Tell the owner what changed with the exact new wording, in Spanish.

## What enforces this

| Rule | Enforcer |
|---|---|
| One reader per money figure, every surface agrees | `src/portfolio/moneyConsistency.test.ts` |
| Telegram: plain words, whole dollars, banned jargon, every close code in words | `src/telegram/plain-money.test.ts` |
| Every live symbol has a plain name in both languages | `src/dashboard/public/v4/js/symbol-names.test.js` |
| Whole-dollar table money, unknown is not zero | `src/dashboard/public/v4/js/fmt.test.js` |
| Sentence-case labels, layout rules | `src/dashboard/public/v4/js/layout.test.js` |
| No sideways scroll on a computer, in English and Spanish | `bun run dashboard:check` (`scripts/dashboard-layout-check.ts`) |
| Nothing scrolls or is clipped inside the Overview board (1280 px wide and up) | `bun run dashboard:check` (the `board` views) |
| The board's figures are the server readers'; the strategies + "outside the strategies" = the total | `src/portfolio/moneyConsistency.test.ts` |
| The files this skill names exist | `src/config/ownerTextSkill.test.ts` |

Not enforced by a test, check by eye: that a text is understandable, the "×"
rule on the dashboard, and every phone width (the check reports phone sizes
without failing).
