"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarCheck,
  DoorOpen,
  Package,
  ShieldCheck,
} from "lucide-react";
import { bookings, reports, venues } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { isoDayOffset, money } from "@/lib/format";
import { PageHeader, StatusBadge } from "@/components/atoms";
import { WithVenue } from "@/components/console/console-gate";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function ConsoleDashboard() {
  return (
    <WithVenue>{(venueId) => <Dashboard venueId={venueId} />}</WithVenue>
  );
}

function Dashboard({ venueId }: { venueId: string }) {
  const from = isoDayOffset(-30);
  const to = isoDayOffset(1);

  const venue = useQuery({
    queryKey: keys.venue(venueId),
    queryFn: () => venues.get(venueId),
  });

  const revenue = useQuery({
    queryKey: keys.revenue(venueId, from, to),
    queryFn: () => reports.revenue(venueId, from, to),
  });

  const rooms = useQuery({
    queryKey: keys.venueRooms(venueId),
    queryFn: () => venues.rooms(venueId),
  });

  const equipment = useQuery({
    queryKey: keys.venueEquipment(venueId),
    queryFn: () => venues.equipment(venueId),
  });

  const live = useQuery({
    queryKey: keys.bookingList({
      status: ["HELD", "PENDING_PAYMENT", "CONFIRMED"],
      limit: 8,
      offset: 0,
    }),
    queryFn: () =>
      bookings.list({
        status: ["HELD", "PENDING_PAYMENT", "CONFIRMED"],
        limit: 8,
      }),
  });

  const reconciliation = useQuery({
    queryKey: keys.reconciliation,
    queryFn: reports.reconciliation,
  });

  return (
    <>
      <PageHeader
        title={venue.data?.name ?? "Console"}
        description={
          venue.data
            ? `${venue.data.city} · ${venue.data.timezone}`
            : "Loading the venue"
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Net, last 30 days"
          value={revenue.data ? money(revenue.data.revenue.netMinor) : undefined}
          hint={
            revenue.data
              ? `${revenue.data.revenue.paidBookings} paid bookings`
              : undefined
          }
        />
        <Stat
          label="Utilisation"
          value={revenue.data ? `${revenue.data.utilisation.pct}%` : undefined}
          hint={
            revenue.data
              ? `${revenue.data.utilisation.bookedHours}h of ${Math.round(revenue.data.utilisation.openHours)}h open`
              : undefined
          }
        />
        <Stat
          label="Live rooms"
          value={
            rooms.data
              ? String(rooms.data.filter((r) => r.active).length)
              : undefined
          }
          hint={
            rooms.data
              ? `${rooms.data.filter((r) => !r.active).length} archived`
              : undefined
          }
        />
        <Stat
          label="Equipment types"
          value={
            equipment.data
              ? String(equipment.data.filter((e) => e.active).length)
              : undefined
          }
          hint={
            equipment.data
              ? `${equipment.data.reduce((s, e) => s + (e.active ? e.units_owned : 0), 0)} units owned`
              : undefined
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Live bookings</CardTitle>
            <Link
              href="/console/bookings"
              className="flex items-center gap-1 text-sm text-primary hover:underline"
            >
              All bookings <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            {live.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : live.data?.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing held, paying or confirmed right now.
              </p>
            ) : (
              <ul className="divide-y">
                {live.data?.map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/bookings/${b.id}`}
                      className="flex items-center justify-between gap-3 py-2.5 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {b.room_name}
                        </span>
                        <span className="tnum block text-xs text-muted-foreground">
                          {new Date(b.start_at).toLocaleString("en-GB", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </span>
                      <span className="tnum shrink-0">{money(b.total_minor)}</span>
                      <StatusBadge status={b.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4" />
                Books balance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {reconciliation.isPending ? (
                <Skeleton className="h-10 w-full" />
              ) : reconciliation.data?.count === 0 ? (
                <p className="text-sm text-confirmed">
                  Zero discrepancies. Every captured charge maps to a confirmed
                  booking or a refund.
                </p>
              ) : (
                <p className="text-sm text-destructive">
                  {reconciliation.data?.count} discrepanc
                  {reconciliation.data?.count === 1 ? "y" : "ies"}.{" "}
                  <Link href="/console/reconciliation" className="underline">
                    Open the report
                  </Link>
                  .
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid gap-1 p-3">
              <Shortcut href="/console/rooms" icon={DoorOpen} label="Rooms" />
              <Shortcut href="/console/equipment" icon={Package} label="Equipment" />
              <Shortcut
                href="/console/bookings"
                icon={CalendarCheck}
                label="Bookings"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {value === undefined ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className="tnum mt-1 text-2xl font-semibold">{value}</p>
        )}
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const Shortcut = ({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) => (
  <Link
    href={href}
    className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent"
  >
    <Icon className="size-4 text-muted-foreground" />
    {label}
  </Link>
);
