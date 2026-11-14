// New York clock and NYSE session counting for the AI review. Sessions come from the
// repo's calendar (`isTradingDay`, src/utils/marketHours.ts), never from a second list.
// Enforced: src/ai-review/calendar.test.ts (winter and summer time, holidays).

import { getPreviousTradingDay, isTradingDay } from "../utils/marketHours";

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export interface NyClock { date: string; minutes: number }

/** The New York calendar date and minutes since midnight at an instant (DST-safe). */
export function nyClock(ms: number): NyClock {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The instant (ms) at which New York shows `date` `hh:mm`. */
export function nyInstant(date: string, hh: number, mm: number): number {
  const base = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  for (const offsetHours of [5, 4]) {
    const t = base + offsetHours * 3_600_000;
    const c = nyClock(t);
    if (c.date === date && c.minutes === hh * 60 + mm) return t;
  }
  throw new Error(`no New York instant for ${date} ${hh}:${mm}`);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** NYSE sessions in (from, to]: the sessions after `from`, up to and including `to`. Counted as the engine counts a hold. */
export function sessionsBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1), guard = 0; d <= to && guard < 800; d = addDays(d, 1), guard++) if (isTradingDay(d)) n++;
  return n;
}

export { getPreviousTradingDay, isTradingDay };
