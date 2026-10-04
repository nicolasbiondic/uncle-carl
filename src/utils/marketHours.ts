// ══════════════════════════════════════════════
// Market Hours — US stock market schedule (ET)
// ══════════════════════════════════════════════

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const NORMAL_CLOSE = 16 * 60; // 960 minutes
const EARLY_CLOSE = 13 * 60;  // 780 minutes
const ET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, weekday: "short",
});
const ET_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", weekday: "short",
});

/** ET wall-clock parts for a timestamp, derived via Intl (DST-safe, America/New_York). */
function getETParts(now: Date | number) {
  const date = typeof now === "number" ? new Date(now) : now;
  const parts: any = Object.fromEntries(ET_PARTS_FORMATTER.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: hour,
    min: Number(parts.minute),
    s: Number(parts.second),
    dow: WEEKDAY[parts.weekday],
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** ET day-of-week for a calendar date key (YYYY-MM-DD). */
function getETDowForDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  // 17:00 UTC is roughly noon ET in both EST and EDT; never near midnight.
  const anchor = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T17:00:00.000Z`).getTime();
  const parts: any = Object.fromEntries(ET_WEEKDAY_FORMATTER.formatToParts(new Date(anchor)).map((p) => [p.type, p.value]));
  return WEEKDAY[parts.weekday];
}

function minutes(h: number, min: number): number {
  return h * 60 + min;
}

export function isMarketOpen(now: Date | number = new Date()): boolean {
  const { dow, dateKey, h, min } = getETParts(now);
  if (dow === 0 || dow === 6 || !isTradingDay(dateKey)) return false;
  const t = minutes(h, min);
  return t >= 570 && t < getSessionClose(dateKey).closeMinutes;
}

export function getMarketStatus(now: Date | number = new Date()): { status: string; untilStr: string } {
  const { dow, dateKey, h, min } = getETParts(now);
  if (dow === 0 || dow === 6 || !isTradingDay(dateKey)) {
    return { status: "closed", untilStr: "Weekend / holiday" };
  }
  const t = minutes(h, min);
  const { closeMinutes, early } = getSessionClose(dateKey);

  if (t >= 570 && t < closeMinutes) {
    const remaining = closeMinutes - t;
    return { status: "open", untilStr: `closes in ${Math.floor(remaining / 60)}h ${remaining % 60}m` };
  }

  if (t >= 240 && t < 570) {
    const remaining = 570 - t;
    return { status: "pre_market", untilStr: `opens in ${Math.floor(remaining / 60)}h ${remaining % 60}m` };
  }

  if (t >= closeMinutes && t < 1200) {
    return { status: "after_hours", untilStr: early ? "After hours (early close)" : "After hours" };
  }

  return { status: "closed", untilStr: "Market closed" };
}

// ── Trading-day calendar (NYSE observed holidays) ───────────────────────────
// ponytail: hardcoded Good Fridays 2024-2035; extend when the bot outlives them.

const GOOD_FRIDAYS = new Set([
  "2024-03-29", "2025-04-18", "2026-04-03", "2027-03-26",
  "2028-04-14", "2029-03-30", "2030-04-19", "2031-04-10",
  "2032-03-26", "2033-04-15", "2034-04-07", "2035-04-20",
]);

// Exchange-wide one-off closures not expressible as recurring holidays.
const SPECIAL_CLOSURES = new Set(["2025-01-09"]); // Carter national day of mourning

function isObserved(_y: number, m: number, d: number, dow: number, holidayMonth: number, holidayDay: number): boolean {
  if (m !== holidayMonth) return false;
  if (d === holidayDay) return true;
  if (dow === 5 && d === holidayDay - 1) return true; // Sat holiday observed Fri
  if (dow === 1 && d === holidayDay + 1) return true; // Sun holiday observed Mon
  return false;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** True if the ET calendar date is a NYSE trading day (weekends + observed holidays excluded). */
export function isTradingDay(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = getETDowForDateKey(dateKey);
  if (dow === 0 || dow === 6) return false;
  if (SPECIAL_CLOSURES.has(dateKey)) return false;

  if (isObserved(y, m, d, dow, 1, 1)) return false;   // New Year's Day
  if (m === 12 && d === 31 && dow === 5 && getETDowForDateKey(`${y + 1}-01-01`) === 6) return false; // New Year's observed Dec 31
  if (m === 1 && dow === 1 && Math.floor((d - 1) / 7) === 2) return false;   // MLK Day
  if (m === 2 && dow === 1 && Math.floor((d - 1) / 7) === 2) return false;   // Presidents Day
  if (GOOD_FRIDAYS.has(dateKey)) return false; // Good Friday
  if (m === 5 && dow === 1 && d > 24) return false; // Memorial Day
  if (isObserved(y, m, d, dow, 6, 19)) return false;   // Juneteenth
  if (isObserved(y, m, d, dow, 7, 4)) return false;    // Independence Day
  if (m === 9 && dow === 1 && d <= 7) return false; // Labor Day
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return false; // Thanksgiving
  if (isObserved(y, m, d, dow, 12, 25)) return false;  // Christmas

  return true;
}

/** Previous trading day before the given ET calendar date. */
export function getPreviousTradingDay(dateKey: string): string {
  let [y, m, d] = dateKey.split("-").map(Number);
  do {
    d -= 1;
    if (d < 1) {
      m -= 1;
      if (m < 1) {
        y -= 1;
        m = 12;
      }
      d = daysInMonth(y, m);
    }
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (isTradingDay(key)) return key;
  } while (true);
}

/** NYSE session close time for a trading day (ET minutes since midnight). */
export function getSessionClose(dateKey: string): { closeMinutes: number; early: boolean } {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = getETDowForDateKey(dateKey);
  if (dow === 0 || dow === 6) return { closeMinutes: NORMAL_CLOSE, early: false };

  // Day after Thanksgiving (Black Friday): early close at 1:00 PM.
  if (m === 11 && dow === 5 && d >= 23 && d <= 29) {
    return { closeMinutes: EARLY_CLOSE, early: true };
  }

  // Christmas Eve: Dec 24 weekday, unless Dec 25 is Saturday (observed closed on Dec 24).
  if (m === 12 && d === 24) {
    const dec25Dow = getETDowForDateKey(`${y}-12-25`);
    if (dec25Dow !== 6) return { closeMinutes: EARLY_CLOSE, early: true };
  }

  // Independence Day adjacent: the trading day before the July 4 holiday.
  if (m === 7 && d >= 1 && d <= 3) {
    const july4Dow = getETDowForDateKey(`${y}-07-04`);
    let earlyDay: number;
    if (july4Dow === 1) {
      earlyDay = 1; // July 4 Mon -> preceding Friday July 1
    } else if (july4Dow >= 2 && july4Dow <= 5) {
      earlyDay = 3; // July 4 Tue-Fri -> July 3
    } else {
      return { closeMinutes: NORMAL_CLOSE, early: false };
    }
    if (d === earlyDay) return { closeMinutes: EARLY_CLOSE, early: true };
  }

  return { closeMinutes: NORMAL_CLOSE, early: false };
}
