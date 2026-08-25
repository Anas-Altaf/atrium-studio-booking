/**
 * The one piece of client logic that can be wrong in a way the API cannot
 * catch: if these rules drift from the server's, the UI offers slots the hold
 * endpoint refuses with 409, and it looks like a race that never happened.
 */
import { describe, expect, it } from "vitest";
import { freeSlots, TURNAROUND_MS } from "./slots";
import type { BusyInterval, OperatingHours } from "./api/types";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const OPEN_09_TO_17: OperatingHours = {
  sun: [["09:00", "17:00"]],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [["09:00", "17:00"]],
};

const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const run = (
  busy: BusyInterval[] = [],
  overrides: Partial<Parameters<typeof freeSlots>[0]> = {},
) =>
  freeSlots({
    busy,
    hours: OPEN_09_TO_17,
    timezone: "UTC",
    durationMin: 60,
    from: day(10),
    to: day(11),
    now: NOW,
    ...overrides,
  });

const taken = (from: string, to: string): BusyInterval => ({
  startAt: from,
  endAt: to,
  status: "CONFIRMED",
});

describe("freeSlots", () => {
  it("walks the open window in 30 minute steps", () => {
    const slots = run();

    expect(slots[0]!.startAt).toBe("2026-03-11T09:00:00.000Z");
    // 09:00 through 16:00 can each hold an hour before a 17:00 close.
    expect(slots).toHaveLength(15);
    expect(slots.at(-1)!.startAt).toBe("2026-03-11T16:00:00.000Z");
  });

  it("never offers a start outside the venue's hours", () => {
    const outside = run().filter((s) => {
      const hour = new Date(s.startAt).getUTCHours();
      return hour < 9 || hour >= 17;
    });
    expect(outside).toEqual([]);
  });

  it("leaves room for the whole duration before closing", () => {
    const slots = run([], { durationMin: 240 });
    expect(slots.at(-1)!.startAt).toBe("2026-03-11T13:00:00.000Z");
  });

  /**
   * The rule the server bakes into `reserved_range` as
   * `[start, end + 15 minutes)`. A booking to 12:00 blocks until 12:15, so the
   * next legal start is 12:30 — the half hour grid rounds it up.
   */
  it("clears the 15 minute turnaround after a booking", () => {
    const slots = run([
      taken("2026-03-11T11:00:00.000Z", "2026-03-11T12:00:00.000Z"),
    ]).map((s) => s.startAt);

    expect(slots).not.toContain("2026-03-11T11:00:00.000Z");
    expect(slots).not.toContain("2026-03-11T12:00:00.000Z");
    expect(slots).toContain("2026-03-11T12:30:00.000Z");
  });

  it("clears the turnaround before a booking too", () => {
    // A 10:00 start running an hour reserves to 11:15, which meets a booking
    // that begins at 11:00.
    const slots = run([
      taken("2026-03-11T11:00:00.000Z", "2026-03-11T12:00:00.000Z"),
    ]).map((s) => s.startAt);

    expect(slots).not.toContain("2026-03-11T10:00:00.000Z");
    expect(slots).toContain("2026-03-11T09:00:00.000Z");
  });

  it("uses the same gap the server stores", () => {
    expect(TURNAROUND_MS).toBe(15 * 60_000);
  });

  it("refuses anything less than an hour ahead", () => {
    // The window is today, and the clock is 09:10 — 09:30 is inside the lead.
    const now = Date.parse("2026-03-11T09:10:00Z");
    const slots = run([], {
      from: "2026-03-11T00:00:00.000Z",
      to: "2026-03-12T00:00:00.000Z",
      now,
    }).map((s) => s.startAt);

    expect(slots).not.toContain("2026-03-11T09:30:00.000Z");
    expect(slots).not.toContain("2026-03-11T10:00:00.000Z");
    expect(slots[0]).toBe("2026-03-11T10:30:00.000Z");
  });

  it("refuses anything past the 90 day ceiling", () => {
    expect(run([], { from: day(91), to: day(92) })).toEqual([]);
    expect(run([], { from: day(89), to: day(90) }).length).toBeGreaterThan(0);
  });

  it("returns nothing on a day the venue is closed", () => {
    expect(run([], { hours: { mon: [["09:00", "17:00"]] } })).toEqual([]);
    expect(run([], { hours: null })).toEqual([]);
  });

  it("handles a venue with two windows in one day", () => {
    const slots = run([], {
      hours: { wed: [["09:00", "12:00"], ["18:00", "22:00"]] },
    }).map((s) => s.startAt);

    expect(slots).toContain("2026-03-11T09:00:00.000Z");
    expect(slots).toContain("2026-03-11T18:00:00.000Z");
    // Between the windows the venue is shut.
    expect(slots).not.toContain("2026-03-11T13:00:00.000Z");
  });

  it("reads the weekday in the venue's zone, not the browser's", () => {
    // 2026-03-11T20:00Z is already Thursday in Karachi (UTC+5).
    const from = "2026-03-11T20:00:00.000Z";
    const to = "2026-03-11T23:00:00.000Z";

    const asKarachi = freeSlots({
      busy: [],
      hours: { thu: [["09:00", "23:59"]] },
      timezone: "Asia/Karachi",
      durationMin: 60,
      from,
      to,
      now: NOW,
    });

    expect(asKarachi.length).toBeGreaterThan(0);
  });

  it("emits ends that match the requested duration exactly", () => {
    for (const slot of run([], { durationMin: 90 })) {
      expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(90 * 60_000);
    }
  });
});
