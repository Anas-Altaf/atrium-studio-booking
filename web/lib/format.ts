/**
 * Money and time.
 *
 * The API is integer minor units end to end. Nothing here does arithmetic on a
 * float — the only division is by 100 at the moment of display.
 */

export function money(minor: number, currency = "PKR"): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/** Compact, for table cells and chart axes. */
export function moneyShort(minor: number): string {
  const major = minor / 100;
  if (Math.abs(major) >= 1_000_000) return `${(major / 1_000_000).toFixed(1)}M`;
  if (Math.abs(major) >= 1_000) return `${(major / 1_000).toFixed(1)}k`;
  return major.toFixed(0);
}

/**
 * In the venue's own timezone, with the zone named.
 *
 * Venues are in Karachi, Dubai and London. Rendering an instant in the
 * browser's zone would show a London customer a Karachi booking at the wrong
 * hour and nothing on screen would say so.
 */
/**
 * `hourCycle: "h23"` everywhere a clock is drawn, never `hour12: false`. The
 * latter selects h24 on some ICU builds, where midnight reads "24:00".
 */
export function venueTime(iso: string, timezone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (timezone) {
    opts.timeZone = timezone;
    opts.timeZoneName = "short";
  }
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

export function venueDate(iso: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(iso));
}

export function clockOnly(iso: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(iso));
}

export function hoursBetween(startIso: string, endIso: string): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
}

export function durationLabel(startIso: string, endIso: string): string {
  const h = hoursBetween(startIso, endIso);
  return Number.isInteger(h) ? `${h}h` : `${Math.floor(h)}h 30m`;
}

/** mm:ss, for the checkout countdown. */
export function countdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function relative(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

export const initials = (email: string) => email.slice(0, 2).toUpperCase();

/** An ISO instant at the start of a UTC day, offset by whole days from today. */
export function isoDayOffset(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + days * 86_400_000).toISOString();
}
