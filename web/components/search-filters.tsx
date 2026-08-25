"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal, X } from "lucide-react";
import { rooms } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { money, isoDayOffset } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/misc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Filters {
  city: string;
  minCapacity: string;
  maxPriceMinor: string;
  amenities: string[];
  from: string;
  to: string;
}

const PRICE_CEILING = 3_000_00;
const ANY = "__any";

/**
 * The window is sent as a pair or not at all — the API refuses one end alone —
 * so the date control writes both or clears both.
 */
export function SearchFilters({
  value,
  onChange,
}: {
  value: Filters;
  onChange: (next: Filters) => void;
}) {
  const { data: facets } = useQuery({
    queryKey: keys.roomFacets,
    queryFn: rooms.facets,
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = React.useState(value);
  const [expanded, setExpanded] = React.useState(false);

  // The URL is the source of truth; a back navigation has to reach the controls.
  React.useEffect(() => setDraft(value), [value]);

  const set = <K extends keyof Filters>(key: K, v: Filters[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));

  const toggleAmenity = (a: string) =>
    setDraft((d) => ({
      ...d,
      amenities: d.amenities.includes(a)
        ? d.amenities.filter((x) => x !== a)
        : [...d.amenities, a],
    }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const active =
    value.city ||
    value.minCapacity ||
    value.maxPriceMinor ||
    value.amenities.length > 0 ||
    value.from;

  const days = value.from
    ? Math.round((Date.parse(value.to) - Date.parse(value.from)) / 86_400_000)
    : 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label>City</Label>
          <Select
            value={draft.city || ANY}
            onValueChange={(v) => set("city", v === ANY ? "" : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Any city" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any city</SelectItem>
              {facets?.cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cap">Seats at least</Label>
          <Input
            id="cap"
            type="number"
            min={1}
            placeholder="Any"
            value={draft.minCapacity}
            onChange={(e) => set("minCapacity", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>
            Up to{" "}
            <span className="tnum">
              {draft.maxPriceMinor ? money(Number(draft.maxPriceMinor)) : "any price"}
            </span>{" "}
            per hour
          </Label>
          <Slider
            className="pt-3"
            min={0}
            max={PRICE_CEILING}
            step={10_000}
            value={[draft.maxPriceMinor ? Number(draft.maxPriceMinor) : PRICE_CEILING]}
            onValueChange={([v]) =>
              set("maxPriceMinor", v === PRICE_CEILING ? "" : String(v))
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>Free for</Label>
          <Select
            value={value.from ? String(days) : ANY}
            onValueChange={(v) => {
              if (v === ANY) {
                onChange({ ...draft, from: "", to: "" });
                return;
              }
              onChange({
                ...draft,
                from: isoDayOffset(1),
                to: isoDayOffset(1 + Number(v)),
              });
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Any time" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any time</SelectItem>
              <SelectItem value="1">Tomorrow</SelectItem>
              <SelectItem value="7">The next 7 days</SelectItem>
              <SelectItem value="30">The next 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {expanded && facets?.amenities.length ? (
        <div className="mt-4 border-t pt-4">
          <Label className="mb-2 block">Amenities</Label>
          <div className="flex flex-wrap gap-1.5">
            {facets.amenities.map((a) => {
              const on = draft.amenities.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggleAmenity(a)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/12 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {a}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
        <Button size="sm" onClick={() => onChange(draft)} disabled={!dirty}>
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded((v) => !v)}
        >
          <SlidersHorizontal />
          {expanded ? "Fewer filters" : "More filters"}
          {draft.amenities.length > 0 && !expanded && (
            <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-xs text-primary">
              {draft.amenities.length}
            </span>
          )}
        </Button>
        {active && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                city: "",
                minCapacity: "",
                maxPriceMinor: "",
                amenities: [],
                from: "",
                to: "",
              })
            }
          >
            <X />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
