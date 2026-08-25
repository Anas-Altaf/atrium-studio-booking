"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  equipment as equipmentApi,
  explain,
  venues,
  type EquipmentAdminRow,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** The brief caps the buffer at 10%. */
const MAX_BUFFER = 0.1;

export function EquipmentForm({
  venueId,
  item,
  onDone,
  onCancel,
}: {
  venueId: string;
  item?: EquipmentAdminRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState(item?.name ?? "");
  const [units, setUnits] = React.useState(String(item?.units_owned ?? 1));
  const [rate, setRate] = React.useState(
    item ? String(item.hourly_rate_minor / 100) : "",
  );
  const [buffer, setBuffer] = React.useState(
    item ? Number(item.overbooking_buffer) : 0,
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        hourlyRateMinor: Math.round(Number(rate) * 100),
        unitsOwned: Number(units),
        // The column is numeric(4,3), so three decimals is all it keeps.
        overbookingBuffer: Number(buffer.toFixed(3)),
      };
      return item
        ? equipmentApi.update(item.id, body)
        : venues.addEquipment(venueId, body);
    },
    onSuccess: () => {
      toast.success(item ? "Equipment saved." : "Equipment added.");
      onDone();
    },
    onError: (err) => toast.error(explain(err)),
  });

  const effective = Math.floor(Number(units || 0) * (1 + buffer));
  const cutting = item ? Number(units) < item.units_owned : false;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? "Edit equipment" : "Add equipment"}</DialogTitle>
          <DialogDescription>
            Availability is a peak over an interval, not a running total — this
            sets the ceiling, not what is free.
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
              <Label htmlFor="units">Units owned</Label>
              <Input
                id="units"
                type="number"
                min={1}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
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

          <div className="space-y-1.5">
            <Label>
              Overbooking buffer{" "}
              <span className="tnum font-normal text-muted-foreground">
                {(buffer * 100).toFixed(1)}%
              </span>
            </Label>
            <Slider
              className="pt-3"
              min={0}
              max={MAX_BUFFER}
              step={0.005}
              value={[buffer]}
              onValueChange={([v]) => setBuffer(v ?? 0)}
            />
            <p className="text-xs text-muted-foreground">
              Absorbs no-shows. Effective capacity becomes{" "}
              <span className="tnum">{effective}</span>, floored — the brief caps
              this at 10%.
            </p>
          </div>

          {cutting && (
            <p className="rounded-md bg-held/10 px-3 py-2 text-sm text-held">
              Cutting units is refused if future bookings already hold more than
              that. Nothing already booked is affected.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {item ? "Save" : "Add equipment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
