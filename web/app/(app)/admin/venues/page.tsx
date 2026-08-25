"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Plus } from "lucide-react";
import { explain, venues, type OperatingHours } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { useVenue } from "@/lib/venue-context";
import { useRouter } from "next/navigation";
import { ErrorState, ListSkeleton, PageHeader } from "@/components/atoms";
import { HoursEditor } from "@/components/console/hours-editor";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function AdminVenuesPage() {
  const queryClient = useQueryClient();
  const { setVenueId } = useVenue();
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: keys.venueList(),
    queryFn: () => venues.list(),
  });

  const open = (id: string) => {
    setVenueId(id);
    router.push("/console");
  };

  return (
    <>
      <PageHeader
        title="All venues"
        description="Open one to manage it — the console follows whichever venue is selected."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New venue
          </Button>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : isPending ? (
        <ListSkeleton />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Venue</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead className="text-right">Rooms</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((venue) => (
                <TableRow key={venue.id}>
                  <TableCell className="font-medium">{venue.name}</TableCell>
                  <TableCell>{venue.city}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {venue.timezone}
                  </TableCell>
                  <TableCell className="tnum text-right">
                    {venue.room_count}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => open(venue.id)}>
                      Open
                      <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && (
        <NewVenueDialog
          onDone={(id) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: keys.venues });
            open(id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </>
  );
}

const WEEKDAYS: OperatingHours = {
  mon: [["09:00", "22:00"]],
  tue: [["09:00", "22:00"]],
  wed: [["09:00", "22:00"]],
  thu: [["09:00", "22:00"]],
  fri: [["09:00", "22:00"]],
  sat: [["10:00", "20:00"]],
  sun: [["12:00", "18:00"]],
};

function NewVenueDialog({
  onDone,
  onCancel,
}: {
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState("");
  const [city, setCity] = React.useState("");
  const [timezone, setTimezone] = React.useState("Asia/Karachi");
  const [hours, setHours] = React.useState<OperatingHours>(WEEKDAYS);

  const create = useMutation({
    mutationFn: () => venues.create({ name, city, timezone, operatingHours: hours }),
    onSuccess: (venue) => {
      toast.success("Venue created on the platform default refund policy.");
      onDone(venue.id);
    },
    onError: (err) => toast.error(explain(err)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New venue</DialogTitle>
          <DialogDescription>
            It starts on the platform default refund policy. Publishing tiers from
            the console moves it onto its own.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="vname">Name</Label>
              <Input
                id="vname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vcity">City</Label>
              <Input
                id="vcity"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vtz">Timezone</Label>
            <Input
              id="vtz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              An IANA zone. Anything else is refused before a booking can be made
              against it.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Operating hours</Label>
            <HoursEditor value={hours} onChange={setHours} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create venue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
