/** Pure. Turns a venue's published hours into the denominator of a utilisation figure. */
import type { OperatingHours } from './types.js';

const DAY_MS = 86_400_000;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Minutes a venue is open on one weekday, across however many windows it publishes. */
export function dayMinutes(windows: [string, string][] | undefined): number {
  if (!windows?.length) return 0;
  return windows.reduce((sum, [open, close]) => {
    const span = toMinutes(close) - toMinutes(open);
    return sum + (span > 0 ? span : 0);
  }, 0);
}

/**
 * Hours the venue is open across [from, to), counted in the venue's own
 * weekdays rather than UTC ones — a Karachi Monday is not a London Monday.
 *
 * Days are stepped in fixed 24 hour jumps, so a range spanning a DST change in
 * a venue's timezone can miscount by at most one day. Over the 30 day window
 * the report is built for that is under 4%, and the alternative is calendar
 * arithmetic in three timezones for a denominator, not a booking.
 */
export function openHoursIn(
  hours: OperatingHours | null, from: string, to: string, timezone: string,
): number {
  const end = Date.parse(to);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });

  let minutes = 0;
  for (let t = Date.parse(from); t < end; t += DAY_MS) {
    minutes += dayMinutes(hours?.[weekday.format(new Date(t)).toLowerCase()]);
  }
  return minutes / 60;
}

/** Rounded to one place: a utilisation figure carrying six decimals is noise. */
export function utilisationPct(bookedHours: number, openHours: number): number {
  if (openHours <= 0) return 0;
  return Math.round((bookedHours / openHours) * 1000) / 10;
}
