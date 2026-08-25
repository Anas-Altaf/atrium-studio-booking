"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, RotateCcw } from "lucide-react";
import { bookings, explain, venues, type BookingDetail } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { clockOnly, countdown, hoursBetween, money, venueDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ErrorState, Money, PageHeader, StatusBadge } from "@/components/atoms";
import { RefundTerms } from "@/components/booking/refund-terms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator, Skeleton } from "@/components/ui/misc";

/** How long to keep asking after a 202 before saying "still pending" honestly. */
const POLL_MS = 2_000;
const POLL_CEILING_MS = 60_000;

/**
 * States that end the wait.
 *
 * Not "anything other than PENDING_PAYMENT": polling starts the moment the pay
 * call returns, and the cached booking is still HELD at that instant, so a
 * negated check stops the poll before it has begun.
 */
const SETTLED = new Set([
  "CONFIRMED",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "REFUNDED",
]);

export default function CheckoutPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [expiresAt, setExpiresAt] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const pollStarted = React.useRef(0);

  const booking = useQuery({
    queryKey: keys.booking(bookingId),
    queryFn: () => bookings.get(bookingId),
    // While a charge is in flight the answer changes without us asking.
    refetchInterval: polling ? POLL_MS : false,
  });

  const venue = useQuery({
    queryKey: keys.venue(booking.data?.venue_id ?? ""),
    queryFn: () => venues.get(booking.data!.venue_id),
    enabled: !!booking.data,
  });

  /**
   * Reaching checkout re-issues the hold for the ten minutes the brief
   * guarantees, and the instant it returns is the only deadline that matters —
   * the reaper runs on the server's clock, not this one.
   */
  const checkout = useMutation({
    mutationFn: () => bookings.checkout(bookingId),
    onSuccess: (r) => setExpiresAt(r.expiresAt),
    onError: (err) => toast.error(explain(err)),
  });

  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current || !booking.data) return;
    started.current = true;
    if (booking.data.status === "HELD") checkout.mutate();
    if (booking.data.status === "PENDING_PAYMENT") beginPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.data]);

  function beginPolling() {
    pollStarted.current = Date.now();
    setPolling(true);
  }

  const pay = useMutation({
    mutationFn: () => bookings.pay(bookingId),
    onSuccess: (result) => {
      // 202 created the charge; 200 found one that already existed (INV-3).
      // Both mean the same thing here: wait for the outcome.
      if (!result.created) toast.info("A payment was already in flight.");
      beginPolling();
      void queryClient.invalidateQueries({ queryKey: keys.booking(bookingId) });
    },
    onError: (err) => toast.error(explain(err)),
  });

  const status = booking.data?.status;

  React.useEffect(() => {
    if (!polling) return;
    if (status && SETTLED.has(status)) {
      setPolling(false);
      void queryClient.invalidateQueries({ queryKey: keys.bookings });
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() - pollStarted.current > POLL_CEILING_MS) setPolling(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, status, queryClient]);

  if (booking.error) return <ErrorState error={booking.error} />;
  if (!booking.data) return <Skeleton className="h-96 w-full" />;

  const b = booking.data;
  const timezone = venue.data?.timezone;

  return (
    <>
      <PageHeader
        title="Checkout"
        description={b.room ? `${b.room.name} · ${b.room.venue_name}` : undefined}
        actions={<StatusBadge status={b.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Outcome
            booking={b}
            polling={polling}
            timedOut={
              !polling &&
              b.status === "PENDING_PAYMENT" &&
              pollStarted.current > 0
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>What you are booking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-sm">
                <p className="font-medium">{venueDate(b.start_at, timezone)}</p>
                <p className="tnum mt-0.5 text-muted-foreground">
                  {clockOnly(b.start_at, timezone)} – {clockOnly(b.end_at, timezone)}
                  {timezone ? ` · ${timezone}` : ""}
                </p>
              </div>

              <Separator />

              <dl className="space-y-2 text-sm">
                {b.lineItems.map((line) => (
                  <div key={line.equipment_type_id} className="flex justify-between">
                    <dt className="text-muted-foreground">
                      {line.name} × {line.quantity}
                    </dt>
                    <dd className="tnum">
                      {money(
                        line.quantity *
                          line.hourly_rate_minor *
                          hoursBetween(b.start_at, b.end_at),
                      )}
                    </dd>
                  </div>
                ))}
                <div className="flex justify-between text-base font-medium">
                  <dt>Total</dt>
                  <dd>
                    <Money minor={b.total_minor} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>If you cancel</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                These are the terms attached to this booking. A policy published
                later cannot change them.
              </p>
            </CardHeader>
            <CardContent>
              <RefundTerms tiers={b.policy.tiers} startAt={b.start_at} />
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Pay</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {b.status === "HELD" && (
                <Countdown
                  expiresAt={expiresAt ?? b.expires_at}
                  onExpire={() => booking.refetch()}
                />
              )}

              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Amount</span>
                <Money minor={b.total_minor} className="text-lg font-semibold" />
              </div>

              {b.status === "HELD" ? (
                <Button
                  className="w-full"
                  loading={pay.isPending || checkout.isPending}
                  onClick={() => pay.mutate()}
                >
                  Pay now
                </Button>
              ) : b.status === "PENDING_PAYMENT" ? (
                <Button className="w-full" loading disabled>
                  Waiting for the provider
                </Button>
              ) : (
                <Button className="w-full" asChild>
                  <Link href={`/bookings/${b.id}`}>View booking</Link>
                </Button>
              )}

              <p className="text-xs text-muted-foreground">
                The charge is submitted to the provider by a background worker and
                confirmed by a callback, so this page waits for the outcome rather
                than assuming one.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * The five things that can come back, drawn differently.
 *
 * `EXPIRED` with a refund is INV-4: the capture landed after the hold died, so
 * the money goes back rather than confirming a slot that was already released.
 */
function Outcome({
  booking,
  polling,
  timedOut,
}: {
  booking: BookingDetail;
  polling: boolean;
  timedOut: boolean;
}) {
  if (booking.status === "CONFIRMED" || booking.status === "COMPLETED") {
    return (
      <Banner tone="confirmed" icon={CheckCircle2} title="Confirmed">
        The money is captured and the room is yours.{" "}
        <Link href={`/bookings/${booking.id}`} className="underline">
          Open the booking
        </Link>
        .
      </Banner>
    );
  }

  if (booking.status === "EXPIRED") {
    return (
      <Banner tone="destructive" icon={AlertTriangle} title="The hold expired">
        {booking.refund ? (
          <>
            The payment arrived after the hold ran out, so the room was released
            and <Money minor={booking.refund.amountMinor} /> is being refunded.
            Nothing is owed.
          </>
        ) : (
          <>The room was released. Take the slot again.</>
        )}
      </Banner>
    );
  }

  if (booking.status === "FAILED") {
    return (
      <Banner tone="destructive" icon={AlertTriangle} title="The payment was declined">
        The provider refused the charge. The slot is no longer held.
      </Banner>
    );
  }

  if (booking.status === "CANCELLED" || booking.status === "REFUNDED") {
    return (
      <Banner tone="muted" icon={RotateCcw} title="Cancelled">
        This booking was cancelled.{" "}
        <Link href={`/bookings/${booking.id}`} className="underline">
          See the refund
        </Link>
        .
      </Banner>
    );
  }

  if (timedOut) {
    return (
      <Banner tone="pending" icon={Clock} title="Still with the provider">
        The charge has not settled yet. It will land on its own — nothing is lost.{" "}
        <Link href={`/bookings/${booking.id}`} className="underline">
          Check the booking
        </Link>
        .
      </Banner>
    );
  }

  if (polling) {
    return (
      <Banner tone="pending" icon={Clock} title="Waiting for the provider">
        The charge is submitted. This updates itself.
      </Banner>
    );
  }

  return null;
}

const TONES = {
  confirmed: "border-confirmed/40 bg-confirmed/10 text-confirmed",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  pending: "border-pending/40 bg-pending/10 text-pending",
  muted: "border-border bg-muted/60 text-muted-foreground",
};

function Banner({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-3 rounded-lg border p-4", TONES[tone])}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div className="text-sm">
        <p className="font-medium">{title}</p>
        <p className="mt-1 opacity-90">{children}</p>
      </div>
    </div>
  );
}

/** Counts down from the server's instant, and warns before it runs out. */
function Countdown({
  expiresAt,
  onExpire,
}: {
  expiresAt: string | null;
  onExpire: () => void;
}) {
  const [left, setLeft] = React.useState(() =>
    expiresAt ? Date.parse(expiresAt) - Date.now() : 0,
  );
  const fired = React.useRef(false);

  React.useEffect(() => {
    if (!expiresAt) return;
    fired.current = false;
    const tick = () => {
      const remaining = Date.parse(expiresAt) - Date.now();
      setLeft(remaining);
      if (remaining <= 0 && !fired.current) {
        fired.current = true;
        onExpire();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, onExpire]);

  if (!expiresAt) return null;

  const dead = left <= 0;
  const urgent = left > 0 && left < 60_000;

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
        dead
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : urgent
            ? "border-held/40 bg-held/10 text-held"
            : "border-border bg-muted/60",
      )}
    >
      <span className="flex items-center gap-1.5">
        <Clock className="size-4" />
        {dead ? "Hold expired" : "Slot held for"}
      </span>
      <span className="tnum font-medium">{countdown(left)}</span>
    </div>
  );
}
