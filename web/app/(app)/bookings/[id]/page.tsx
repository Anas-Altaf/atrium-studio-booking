"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Bot, User } from "lucide-react";
import { bookings, explain, venues } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import {
  clockOnly,
  hoursBetween,
  money,
  venueDate,
  venueTime,
} from "@/lib/format";
import {
  ErrorState,
  Field,
  Money,
  PageHeader,
  PaymentBadge,
  StatusBadge,
} from "@/components/atoms";
import { RefundTerms, bandFor } from "@/components/booking/refund-terms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator, Skeleton } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const CANCELLABLE = new Set(["HELD", "PENDING_PAYMENT", "CONFIRMED"]);

export default function BookingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const booking = useQuery({
    queryKey: keys.booking(id),
    queryFn: () => bookings.get(id),
  });

  const audit = useQuery({
    queryKey: keys.bookingAudit(id),
    queryFn: () => bookings.audit(id),
  });

  const venue = useQuery({
    queryKey: keys.venue(booking.data?.venue_id ?? ""),
    queryFn: () => venues.get(booking.data!.venue_id),
    enabled: !!booking.data,
  });

  if (booking.error) return <ErrorState error={booking.error} />;
  if (!booking.data) return <Skeleton className="h-96 w-full" />;

  const b = booking.data;
  const timezone = venue.data?.timezone;
  const hours = hoursBetween(b.start_at, b.end_at);
  const equipmentMinor = b.lineItems.reduce(
    (sum, l) => sum + l.quantity * l.hourly_rate_minor * hours,
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
        title={b.room?.name ?? "Booking"}
        description={
          b.room ? `${b.room.venue_name} · ${b.room.city}` : undefined
        }
        actions={
          <>
            <StatusBadge status={b.status} />
            {b.status === "HELD" && (
              <Button size="sm" asChild>
                <Link href={`/checkout/${b.id}`}>Continue to payment</Link>
              </Button>
            )}
            {CANCELLABLE.has(b.status) && <CancelButton bookingId={b.id} />}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Booking</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="Date">{venueDate(b.start_at, timezone)}</Field>
                <Field label="Time">
                  <span className="tnum">
                    {clockOnly(b.start_at, timezone)} –{" "}
                    {clockOnly(b.end_at, timezone)}
                  </span>
                  {timezone && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {timezone}
                    </span>
                  )}
                </Field>
                <Field label="Reference">
                  <span className="font-mono text-xs">{b.id}</span>
                </Field>
                <Field label="Total">
                  <Money minor={b.total_minor} />
                </Field>
              </dl>

              {b.lineItems.length > 0 && (
                <>
                  <Separator className="my-5" />
                  <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                    Equipment
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Rate / h</TableHead>
                        <TableHead className="text-right">Line</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {b.lineItems.map((l) => (
                        <TableRow key={l.equipment_type_id}>
                          <TableCell>{l.name}</TableCell>
                          <TableCell className="tnum text-right">
                            {l.quantity}
                          </TableCell>
                          <TableCell className="tnum text-right">
                            {money(l.hourly_rate_minor)}
                          </TableCell>
                          <TableCell className="tnum text-right">
                            {money(l.quantity * l.hourly_rate_minor * hours)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Rates are frozen at the moment of the hold — a later price
                    change cannot reach this booking.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Append-only. Every state change writes exactly one row, and
                nothing can edit or remove one.
              </p>
            </CardHeader>
            <CardContent>
              {audit.isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : audit.error ? (
                <ErrorState error={audit.error} />
              ) : (
                <ol className="space-y-0">
                  {audit.data.map((row, i) => (
                    <li key={row.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full border bg-card">
                          {row.actor_email ? (
                            <User className="size-3.5 text-muted-foreground" />
                          ) : (
                            <Bot className="size-3.5 text-pending" />
                          )}
                        </span>
                        {i < audit.data.length - 1 && (
                          <span className="w-px flex-1 bg-border" />
                        )}
                      </div>
                      <div className="pb-5">
                        <p className="text-sm">
                          {row.from_state ? (
                            <>
                              <span className="text-muted-foreground">
                                {row.from_state}
                              </span>
                              <span className="mx-1.5 text-muted-foreground">→</span>
                            </>
                          ) : null}
                          <span className="font-medium">{row.to_state}</span>
                        </p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {row.reason}
                        </p>
                        <p className="tnum mt-0.5 text-xs text-muted-foreground">
                          {venueTime(row.occurred_at, timezone)} ·{" "}
                          {row.actor_email ?? "system"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Money</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Room</dt>
                  <dd className="tnum">{money(b.total_minor - equipmentMinor)}</dd>
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
                  <dd className="tnum">{money(b.total_minor)}</dd>
                </div>
              </dl>

              <Separator />

              {b.payment ? (
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Payment</span>
                    <PaymentBadge status={b.payment.status} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Charged</span>
                    <Money minor={b.payment.amountMinor} currency={b.payment.currency} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No payment has been submitted.
                </p>
              )}

              {b.refund && (
                <>
                  <Separator />
                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Refund</span>
                      <span className="text-refunded">{b.refund.status}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount</span>
                      <Money minor={b.refund.amountMinor} />
                    </div>
                    <p className="text-xs text-muted-foreground">{b.refund.reason}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cancellation terms</CardTitle>
            </CardHeader>
            <CardContent>
              <RefundTerms tiers={b.policy.tiers} startAt={b.start_at} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Quotes the refund before asking. A repeat cancel answers 200 with the same
 * refund rather than an error, so a double click is safe by construction.
 */
function CancelButton({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();

  const booking = useQuery({
    queryKey: keys.booking(bookingId),
    queryFn: () => bookings.get(bookingId),
  });

  const cancel = useMutation({
    mutationFn: () => bookings.cancel(bookingId),
    onSuccess: (result) => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: keys.bookings });
      toast.success(
        result.refund
          ? `Cancelled. ${money(result.refund.amountMinor)} is being refunded.`
          : "Cancelled. Nothing had been charged.",
      );
    },
    onError: (err) => toast.error(explain(err)),
  });

  const b = booking.data;
  const band = b ? bandFor(b.policy.tiers, b.start_at) : null;
  const paid = b?.payment?.status === "CAPTURED";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Cancel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this booking?</DialogTitle>
          <DialogDescription>
            The slot is released immediately. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {b && (
          <div className="rounded-md border p-3 text-sm">
            {!paid ? (
              <p className="text-muted-foreground">
                Nothing has been charged, so there is nothing to refund.
              </p>
            ) : band ? (
              <p>
                Under the band that applies now, you get back{" "}
                <span className="font-medium">{band.room_pct}%</span> of the room
                and{" "}
                <span className="font-medium">{band.equipment_pct}%</span> of the
                equipment.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No refund band covers this time.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
