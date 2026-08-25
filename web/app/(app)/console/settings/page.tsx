"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { explain, venues, type OperatingHours } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { ErrorState, PageHeader } from "@/components/atoms";
import { WithVenue, useCanWrite } from "@/components/console/console-gate";
import { HoursEditor } from "@/components/console/hours-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function VenueSettingsPage() {
  return <WithVenue>{(venueId) => <VenueSettings venueId={venueId} />}</WithVenue>;
}

const ZONES = [
  "Asia/Karachi",
  "Asia/Dubai",
  "Europe/London",
  "UTC",
  "America/New_York",
];

function VenueSettings({ venueId }: { venueId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: keys.venue(venueId),
    queryFn: () => venues.get(venueId),
  });

  const [name, setName] = React.useState<string | null>(null);
  const [city, setCity] = React.useState<string | null>(null);
  const [timezone, setTimezone] = React.useState<string | null>(null);
  const [hours, setHours] = React.useState<OperatingHours | null>(null);

  const save = useMutation({
    mutationFn: () =>
      venues.update(venueId, {
        ...(name !== null ? { name } : {}),
        ...(city !== null ? { city } : {}),
        ...(timezone !== null ? { timezone } : {}),
        ...(hours !== null ? { operatingHours: hours } : {}),
      }),
    onSuccess: () => {
      toast.success("Venue saved.");
      setName(null);
      setCity(null);
      setTimezone(null);
      setHours(null);
      void queryClient.invalidateQueries({ queryKey: keys.venues });
      // The city is denormalised onto every room for search.
      void queryClient.invalidateQueries({ queryKey: keys.rooms });
    },
    onError: (err) => toast.error(explain(err)),
  });

  if (error) return <ErrorState error={error} />;
  if (isPending) return <Skeleton className="h-96 w-full" />;

  const dirty =
    name !== null || city !== null || timezone !== null || hours !== null;

  return (
    <>
      <PageHeader
        title="Venue settings"
        description="Operating hours decide which bookings the API will accept at all."
        actions={
          canWrite && (
            <Button
              size="sm"
              loading={save.isPending}
              disabled={!dirty}
              onClick={() => save.mutate()}
            >
              Save changes
            </Button>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                disabled={!canWrite}
                value={name ?? data.name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                disabled={!canWrite}
                value={city ?? data.city}
                onChange={(e) => setCity(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Copied onto every room in this venue, because cross-venue search
                filters on it without a join. Changing it moves the rooms too.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tz">Timezone</Label>
              <Input
                id="tz"
                list="zones"
                disabled={!canWrite}
                value={timezone ?? data.timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id="zones">
                {ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                An IANA zone. Operating hours and refund boundaries are evaluated
                in it, so London&apos;s clock change is handled by Postgres rather
                than by an offset.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Operating hours</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              A booking outside these is refused with 400, not 409.
            </p>
          </CardHeader>
          <CardContent>
            <HoursEditor
              value={hours ?? data.operating_hours}
              disabled={!canWrite}
              onChange={setHours}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
