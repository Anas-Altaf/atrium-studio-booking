/**
 * Free slots, derived on the client.
 *
 * `GET /rooms/:id/availability` returns *busy* intervals and the venue's
 * operating hours — not free slots — because "free" depends on how long the
 * caller wants and where they would start. Deriving it here is the price of
 * that, and the arithmetic has to match the server exactly or the UI offers
 * slots the hold endpoint rejects.
 *
 * The two rules that are easy to get wrong:
 *
 *  - **Turnaround.** The database stores `reserved_range` as
 *    `[start, end + 15 minutes)`, so a booking blocks a quarter of an hour past
 *    its end and a new booking must clear the same gap on both sides.
 *  - **Advance window.** Bookings open one hour ahead and close ninety days
 *    ahead. A slot outside that is refused with 400, not 409.
 */
import type { BusyInterval, OperatingHours } from "./api";

export const STEP_MIN = 30;
export const TURNAROUND_MS = 15 * 60_000;
const MIN_LEAD_MS = 60 * 60_000;
const MAX_AHEAD_MS = 90 * 86_400_000;
const MIN_MS = 60_000;

export interface Slot {
  startAt: string;
  endAt: string;
}

const dayKey = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(at)
    .toLowerCase();

/** The instant that is `hh:mm` local on the calendar day `at` falls in. */
function localInstant(at: Date, hhmm: string, timezone: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  // Resolve the day's own UTC offset by comparing the formatted local time back
  // to the instant, rather than assuming a fixed offset — London has two.
  //
  // `hourCycle: "h23"`, not `hour12: false`. The latter selects h24 in en-US on
  // some ICU builds, where midnight formats as "24" rather than "00" — which
  // reads here as a 24 hour offset and moves every slot a day earlier. It is
  // engine-dependent, so it passed locally and failed in CI.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  // % 24 so an engine that ignores the hour cycle still cannot shift a day.
  const lh = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const lm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);

  const localNow = lh * 60 + lm;
  const wanted = h! * 60 + m!;
  return at.getTime() + (wanted - localNow) * MIN_MS;
}

export interface SlotOptions {
  busy: BusyInterval[];
  hours: OperatingHours | null;
  timezone: string;
  /** Whole hours, from the room's own min/max. */
  durationMin: number;
  from: string;
  to: string;
  now?: number;
}

/**
 * Every start the server would accept, for one duration, over the window.
 *
 * Walks each open window in 30 minute steps — the brief's granularity — and
 * drops a start whose reserved range, turnaround included, meets a busy one.
 */
export function freeSlots(opts: SlotOptions): Slot[] {
  const now = opts.now ?? Date.now();
  const earliest = now + MIN_LEAD_MS;
  const latest = now + MAX_AHEAD_MS;

  const blocked = opts.busy.map((b) => ({
    from: Date.parse(b.startAt),
    to: Date.parse(b.endAt) + TURNAROUND_MS,
  }));

  const durationMs = opts.durationMin * MIN_MS;
  const out: Slot[] = [];
  const end = Date.parse(opts.to);

  for (let day = Date.parse(opts.from); day < end; day += 86_400_000) {
    const at = new Date(day);
    const windows = opts.hours?.[dayKey(at, opts.timezone)] ?? [];

    for (const [open, close] of windows) {
      const openAt = localInstant(at, open, opts.timezone);
      const closeAt = localInstant(at, close, opts.timezone);

      // Align to the half hour the constraint requires.
      const first = Math.ceil(openAt / (STEP_MIN * MIN_MS)) * (STEP_MIN * MIN_MS);

      for (let t = first; t + durationMs <= closeAt; t += STEP_MIN * MIN_MS) {
        if (t < earliest || t > latest) continue;

        const slotEnd = t + durationMs;
        const reservedTo = slotEnd + TURNAROUND_MS;
        const clashes = blocked.some((b) => b.from < reservedTo && t < b.to);
        if (clashes) continue;

        out.push({
          startAt: new Date(t).toISOString(),
          endAt: new Date(slotEnd).toISOString(),
        });
      }
    }
  }

  return out;
}

/** Slots keyed by their local calendar day, for a week view. */
export function groupByDay(
  slots: Slot[],
  timezone: string,
): { day: string; label: string; slots: Slot[] }[] {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const buckets = new Map<string, Slot[]>();

  for (const slot of slots) {
    const label = fmt.format(new Date(slot.startAt));
    const list = buckets.get(label);
    if (list) list.push(slot);
    else buckets.set(label, [slot]);
  }

  return [...buckets].map(([label, list]) => ({
    day: list[0]!.startAt,
    label,
    slots: list,
  }));
}

/** The durations a room allows, in whole 30 minute steps. */
export function durationChoices(minMin: number, maxMin: number): number[] {
  const out: number[] = [];
  for (let m = minMin; m <= maxMin; m += STEP_MIN) out.push(m);
  return out;
}

export const durationLabel = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h 30m`;
