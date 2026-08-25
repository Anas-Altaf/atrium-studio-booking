"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Minus, Plus, Users } from "lucide-react";
import { bookings, explain, rooms, venues } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { clockOnly, isoDayOffset, money, venueDate } from "@/lib/format";
import { durationChoices, durationLabel, type Slot } from "@/lib/slots";
import { ErrorState, PageHeader } from "@/components/atoms";
import { SlotPicker, BusyStrip } from "@/components/booking/slot-picker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton, Separator } from "@/components/ui/misc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const WINDOW_DAYS = 7;

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [weekOffset, setWeekOffset] = React.useState(0);
  const [durationMin, setDurationMin] = React.useState(60);
  const [slot, setSlot] = React.useState<Slot | null>(null);
  const [picked, setPicked] = React.useState<Record<string, number>>({});

  // A search that carried a window lands on the week containing it.
  const startDay = React.useMemo(() => {
    const fromParam = search.get("from");
    const base = fromParam ? Date.parse(fromParam) : Date.parse(isoDayOffset(0));
    return new Date(base + weekOffset * WINDOW_DAYS * 86_400_000).toISOString();
  }, [search, weekOffset]);

  const endDay = new Date(
    Date.parse(startDay) + WINDOW_DAYS * 86_400_000,
  ).toISOString();

  const room = useQuery({ queryKey: keys.room(id), queryFn: () => rooms.get(id) });

  const venue = useQuery({
    queryKey: keys.venue(room.data?.venue_id ?? ""),
    queryFn: () => venues.get(room.data!.venue_id),
    enabled: !!room.data,
  });

  const availability = useQuery({
    queryKey: keys.roomAvailability(id, startDay, endDay),
    queryFn: () => rooms.availability(id, startDay, endDay),
    staleTime: 10_000,
  });

  const equipment = useQuery({
    queryKey: keys.roomEquipment(id),
    queryFn: () => rooms.equipment(id),
  });

  React.useEffect(() => {
    if (room.data) setDurationMin(room.data.min_duration_min);
  }, [room.data]);

  // The window moved, so the chosen slot may no longer be on screen.
  React.useEffect(() => setSlot(null), [startDay, durationMin]);

  const hold = useMutation({
    mutationFn: () =>
      bookings.hold({
        roomId: id,
        startAt: slot!.startAt,
        endAt: slot!.endAt,
        equipment: Object.entries(picked)
          .filter(([, q]) => q > 0)
          .map(([equipmentTypeId, quantity]) => ({ equipmentTypeId, quantity })),
      }),
    onSuccess: (booking) => {
      void queryClient.invalidateQueries({ queryKey: keys.bookings });
      router.push(`/checkout/${booking.id}`);
    },
    onError: (err) => {
      toast.error(explain(err));
      // Someone else took it, or the hold fell outside a rule. Either way the
      // picture on screen is stale.
      void queryClient.invalidateQueries({
        queryKey: keys.roomAvailability(id, startDay, endDay),
      });
      setSlot(null);
    },
  });

  if (room.error) return <ErrorState error={room.error} />;
  if (!room.data) return <RoomSkeleton />;

  const timezone = venue.data?.timezone ?? "UTC";
  const hours = availability.data?.operatingHours ?? null;
  const busy = availability.data?.busy ?? [];

  const durationHours = durationMin / 60;
  const roomMinor = Math.round(room.data.hourly_rate_minor * durationHours);
  const equipmentMinor = (equipment.data ?? []).reduce(
    (sum, e) => sum + (picked[e.id] ?? 0) * e.hourly_rate_minor * durationHours,
    0,
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-3"
        onClick={() => router.back()}
      >
        <ArrowLeft />
        Back
      </Button>

      <PageHeader
        title={room.data.name}
        description={`${room.data.venue_name} · ${room.data.city}`}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5 text-sm">
              <span className="flex items-center gap-1.5">
                <Users className="size-4 text-muted-foreground" />
                seats {room.data.capacity}
              </span>
              <span>
                <span className="tnum font-medium">
                  {money(room.data.hourly_rate_minor)}
                </span>{" "}
                <span className="text-muted-foreground">per hour</span>
              </span>
              <span className="text-muted-foreground">
                {durationLabel(room.data.min_duration_min)} to{" "}
                {durationLabel(room.data.max_duration_min)}
              </span>
              {room.data.amenities.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {room.data.amenities.map((a) => (
                    <Badge key={a} variant="secondary">
                      {a}
                    </Badge>
                  ))}
                </span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Pick a time</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {venueDate(startDay, timezone)} onwards, in {timezone}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={weekOffset === 0}
                  onClick={() => setWeekOffset((w) => w - 1)}
                >
                  Earlier
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWeekOffset((w) => w + 1)}
                >
                  Later
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Duration</span>
                <Select
                  value={String(durationMin)}
                  onValueChange={(v) => setDurationMin(Number(v))}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {durationChoices(
                      room.data.min_duration_min,
                      room.data.max_duration_min,
                    ).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {durationLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {availability.isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : availability.error ? (
                <ErrorState error={availability.error} />
              ) : (
                <>
                  <BusyStrip
                    busy={busy}
                    timezone={timezone}
                    from={startDay}
                    to={endDay}
                  />
                  <Separator />
                  <SlotPicker
                    busy={busy}
                    hours={hours}
                    timezone={timezone}
                    durationMin={durationMin}
                    from={startDay}
                    to={endDay}
                    selected={slot}
                    onSelect={setSlot}
                  />
                </>
              )}
            </CardContent>
          </Card>

          {equipment.data && equipment.data.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Add equipment</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Charged per hour for the same interval. Availability is settled
                  when the hold is placed, not here.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {equipment.data.map((item) => {
                  const qty = picked[item.id] ?? 0;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-4 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          <span className="tnum">
                            {money(item.hourly_rate_minor)}
                          </span>{" "}
                          per hour · {item.units_owned} owned
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8"
                          disabled={qty === 0}
                          onClick={() =>
                            setPicked((p) => ({ ...p, [item.id]: qty - 1 }))
                          }
                          aria-label={`One fewer ${item.name}`}
                        >
                          <Minus />
                        </Button>
                        <span className="tnum w-8 text-center text-sm">{qty}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8"
                          disabled={qty >= item.units_owned}
                          onClick={() =>
                            setPicked((p) => ({ ...p, [item.id]: qty + 1 }))
                          }
                          aria-label={`One more ${item.name}`}
                        >
                          <Plus />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Your booking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {slot ? (
                <div className="rounded-md bg-accent/60 p-3 text-sm">
                  <p className="font-medium">{venueDate(slot.startAt, timezone)}</p>
                  <p className="tnum mt-0.5 text-muted-foreground">
                    {clockOnly(slot.startAt, timezone)} –{" "}
                    {clockOnly(slot.endAt, timezone)} · {durationLabel(durationMin)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Pick a time to see the price.
                </p>
              )}

              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Room</dt>
                  <dd className="tnum">{money(roomMinor)}</dd>
                </div>
                {equipmentMinor > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Equipment</dt>
                    <dd className="tnum">{money(equipmentMinor)}</dd>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-medium">
                  <dt>Total</dt>
                  <dd className="tnum">{money(roomMinor + equipmentMinor)}</dd>
                </div>
              </dl>

              <Button
                className="w-full"
                disabled={!slot}
                loading={hold.isPending}
                onClick={() => hold.mutate()}
              >
                Hold this slot
              </Button>

              <p className="text-xs text-muted-foreground">
                A hold reserves the room for 8 minutes. Reaching checkout gives you
                10 minutes to pay.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

const RoomSkeleton = () => (
  <div className="space-y-6">
    <Skeleton className="h-9 w-64" />
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Skeleton className="h-96 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  </div>
);
