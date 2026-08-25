"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  bookings as api,
  type BookingFilter,
  type BookingStatus,
} from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { durationLabel, money, venueTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  ErrorState,
  ListSkeleton,
  StatusBadge,
} from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const FILTERS: { label: string; statuses?: BookingStatus[] }[] = [
  { label: "All" },
  { label: "Live", statuses: ["HELD", "PENDING_PAYMENT", "CONFIRMED"] },
  { label: "Confirmed", statuses: ["CONFIRMED"] },
  { label: "Past", statuses: ["COMPLETED"] },
  { label: "Cancelled", statuses: ["CANCELLED", "REFUNDED"] },
  { label: "Dead", statuses: ["EXPIRED", "FAILED"] },
];

const PAGE = 20;

/**
 * One table for both "my bookings" and a venue's. The API scopes the rows by
 * the caller's token, so there is nothing to branch on here.
 */
export function BookingsTable({ showCustomer }: { showCustomer?: boolean }) {
  const [tab, setTab] = React.useState(0);
  const [page, setPage] = React.useState(0);

  const filter: BookingFilter = {
    status: FILTERS[tab]!.statuses,
    limit: PAGE,
    offset: page * PAGE,
  };

  const { data, isPending, error, isFetching } = useQuery({
    queryKey: keys.bookingList(filter),
    queryFn: () => api.list(filter),
  });

  React.useEffect(() => setPage(0), [tab]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f, i) => (
          <button
            key={f.label}
            onClick={() => setTab(i)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              i === tab
                ? "border-primary bg-primary/12 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} />
      ) : data.length === 0 ? (
        <EmptyState
          title={page > 0 ? "Nothing further back" : "No bookings here"}
          hint={
            page > 0
              ? undefined
              : "Bookings appear as soon as a hold is placed, not only once paid."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Length</TableHead>
                {showCustomer && <TableHead>Customer</TableHead>}
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((b) => (
                <TableRow key={b.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/bookings/${b.id}`} className="block">
                      <span className="font-medium">{b.room_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {b.venue_name} · {b.city}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="tnum whitespace-nowrap">
                    <Link href={`/bookings/${b.id}`}>{venueTime(b.start_at)}</Link>
                  </TableCell>
                  <TableCell className="tnum">
                    {durationLabel(b.start_at, b.end_at)}
                  </TableCell>
                  {showCustomer && (
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {b.user_id.slice(0, 8)}
                    </TableCell>
                  )}
                  <TableCell className="tnum text-right">
                    {money(b.total_minor)}
                  </TableCell>
                  <TableCell className="text-right">
                    <StatusBadge status={b.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isFetching ? "Loading…" : `Page ${page + 1}`}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.length < PAGE}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
