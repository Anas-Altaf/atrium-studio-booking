"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { clockOnly } from "@/lib/format";
import type { BusyInterval, OperatingHours } from "@/lib/api";
import { freeSlots, groupByDay, type Slot } from "@/lib/slots";
import { EmptyState } from "@/components/atoms";

/**
 * Free starts for one duration, grouped by the venue's local day.
 *
 * The derivation is in `lib/slots.ts`; this only draws it. The turnaround gap
 * is applied there, so a slot offered here is one the hold endpoint accepts.
 */
export function SlotPicker({
  busy,
  hours,
  timezone,
  durationMin,
  from,
  to,
  selected,
  onSelect,
}: {
  busy: BusyInterval[];
  hours: OperatingHours | null;
  timezone: string;
  durationMin: number;
  from: string;
  to: string;
  selected: Slot | null;
  onSelect: (slot: Slot) => void;
}) {
  const days = React.useMemo(
    () =>
      groupByDay(
        freeSlots({ busy, hours, timezone, durationMin, from, to }),
        timezone,
      ),
    [busy, hours, timezone, durationMin, from, to],
  );

  if (!days.length) {
    return (
      <EmptyState
        title="Nothing free in this window"
        hint="Try a shorter booking or move to the following week."
      />
    );
  }

  return (
    <div className="space-y-5">
      {days.map((day) => (
        <div key={day.label}>
          <p className="mb-2 text-sm font-medium">{day.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {day.slots.map((slot) => {
              const on = selected?.startAt === slot.startAt;
              return (
                <button
                  key={slot.startAt}
                  type="button"
                  onClick={() => onSelect(slot)}
                  className={cn(
                    "tnum rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:border-primary/50 hover:bg-accent",
                  )}
                >
                  {clockOnly(slot.startAt, timezone)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What is already taken, as a week strip. Read-only on purpose: the picker
 * above is where a slot is chosen, and a drag-to-select calendar is Tier 3.
 */
export function BusyStrip({
  busy,
  timezone,
  from,
  to,
}: {
  busy: BusyInterval[];
  timezone: string;
  from: string;
  to: string;
}) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
  });

  const days: { label: string; start: number; taken: BusyInterval[] }[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += 86_400_000) {
    const label = fmt.format(new Date(t));
    days.push({
      label,
      start: t,
      taken: busy.filter(
        (b) => Date.parse(b.startAt) < t + 86_400_000 && Date.parse(b.endAt) > t,
      ),
    });
  }

  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((day) => (
        <div key={day.start} className="rounded-md border p-2">
          <p className="mb-1.5 text-[11px] text-muted-foreground">{day.label}</p>
          <div className="space-y-1">
            {day.taken.length === 0 ? (
              <p className="text-[11px] text-confirmed">open</p>
            ) : (
              day.taken.slice(0, 4).map((b, i) => (
                <p key={i} className="tnum text-[11px] text-muted-foreground">
                  {clockOnly(b.startAt, timezone)}
                </p>
              ))
            )}
            {day.taken.length > 4 && (
              <p className="text-[11px] text-muted-foreground">
                +{day.taken.length - 4}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
