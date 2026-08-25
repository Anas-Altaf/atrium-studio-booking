"use client";

import { Plus, X } from "lucide-react";
import type { OperatingHours } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DAYS: [string, string][] = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

/**
 * Seven days, each with zero or more windows. A day with no windows is closed,
 * which is how the API reads a missing key.
 */
export function HoursEditor({
  value,
  disabled,
  onChange,
}: {
  value: OperatingHours;
  disabled?: boolean;
  onChange: (next: OperatingHours) => void;
}) {
  const set = (day: string, windows: [string, string][]) => {
    const next = { ...value };
    if (windows.length) next[day] = windows;
    else delete next[day];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {DAYS.map(([key, label]) => {
        const windows = value[key] ?? [];
        return (
          <div key={key} className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-sm">{label}</span>

            {windows.length === 0 ? (
              <span className="text-sm text-muted-foreground">Closed</span>
            ) : (
              windows.map((w, i) => (
                <span key={i} className="flex items-center gap-1">
                  <Input
                    type="time"
                    className="tnum h-8 w-28"
                    disabled={disabled}
                    value={w[0]}
                    onChange={(e) =>
                      set(
                        key,
                        windows.map((x, j) =>
                          i === j ? [e.target.value, x[1]] : x,
                        ),
                      )
                    }
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="time"
                    className="tnum h-8 w-28"
                    disabled={disabled}
                    value={w[1]}
                    onChange={(e) =>
                      set(
                        key,
                        windows.map((x, j) =>
                          i === j ? [x[0], e.target.value] : x,
                        ),
                      )
                    }
                  />
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => set(key, windows.filter((_, j) => j !== i))}
                      aria-label={`Remove ${label} window`}
                    >
                      <X />
                    </Button>
                  )}
                </span>
              ))
            )}

            {!disabled && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set(key, [...windows, ["09:00", "22:00"]])}
              >
                <Plus />
                {windows.length ? "Another" : "Open"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
