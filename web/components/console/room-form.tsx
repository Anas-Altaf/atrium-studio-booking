"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import { explain, rooms, venues, type RoomAdminRow } from "@/lib/api";
import { durationChoices, durationLabel } from "@/lib/slots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The brief's granularity: 30 minute steps, one hour to eight. */
const CHOICES = durationChoices(60, 480);

export function RoomForm({
  venueId,
  room,
  onDone,
  onCancel,
}: {
  venueId: string;
  room?: RoomAdminRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState(room?.name ?? "");
  const [capacity, setCapacity] = React.useState(String(room?.capacity ?? 8));
  const [rate, setRate] = React.useState(
    room ? String(room.hourly_rate_minor / 100) : "",
  );
  const [minDuration, setMin] = React.useState(room?.min_duration_min ?? 60);
  const [maxDuration, setMax] = React.useState(room?.max_duration_min ?? 480);
  const [amenities, setAmenities] = React.useState<string[]>(room?.amenities ?? []);
  const [draft, setDraft] = React.useState("");

  const save = useMutation({
    mutationFn: () => {
      // The form takes major units because that is what a person types; the API
      // is integer minor units, so the conversion happens once, here.
      const body = {
        name,
        capacity: Number(capacity),
        hourlyRateMinor: Math.round(Number(rate) * 100),
        amenities,
        minDurationMin: minDuration,
        maxDurationMin: maxDuration,
      };
      return room ? rooms.update(room.id, body) : venues.addRoom(venueId, body);
    },
    onSuccess: () => {
      toast.success(room ? "Room saved." : "Room added.");
      onDone();
    },
    onError: (err) => toast.error(explain(err)),
  });

  const addAmenity = () => {
    const value = draft.trim().toLowerCase();
    if (value && !amenities.includes(value)) setAmenities([...amenities, value]);
    setDraft("");
  };

  const invalid = maxDuration < minDuration;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{room ? "Edit room" : "Add a room"}</DialogTitle>
          <DialogDescription>
            The city comes from the venue — it is denormalised onto the room for
            search, not chosen here.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="capacity">Seats</Label>
              <Input
                id="capacity"
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate">Rate per hour (PKR)</Label>
              <Input
                id="rate"
                type="number"
                min={0}
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Shortest booking</Label>
              <Select value={String(minDuration)} onValueChange={(v) => setMin(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {durationLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Longest booking</Label>
              <Select value={String(maxDuration)} onValueChange={(v) => setMax(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {durationLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {invalid && (
            <p className="text-sm text-destructive">
              The longest booking cannot be shorter than the shortest.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="amenity">Amenities</Label>
            <div className="flex gap-2">
              <Input
                id="amenity"
                value={draft}
                placeholder="wifi, piano, soundproof…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAmenity();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addAmenity}>
                Add
              </Button>
            </div>
            {amenities.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {amenities.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmenities(amenities.filter((x) => x !== a))}
                    className="flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent"
                  >
                    {a}
                    <X className="size-3" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={invalid}>
              {room ? "Save" : "Add room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
