"use client";

import { useVenue } from "@/lib/venue-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Only a platform admin sees this: every other role is pinned to one venue. */
export function VenueSwitcher() {
  const { venueId, choices, switchable, setVenueId } = useVenue();
  if (!switchable || choices.length === 0) return null;

  return (
    <Select value={venueId ?? undefined} onValueChange={setVenueId}>
      <SelectTrigger className="h-8 w-56 text-sm">
        <SelectValue placeholder="Pick a venue" />
      </SelectTrigger>
      <SelectContent>
        {choices.map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.name} · {v.city}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
