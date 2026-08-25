"use client";

import * as React from "react";
import { AlertCircle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiError, explain, type BookingStatus, type PaymentStatus } from "@/lib/api";
import { money, venueTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/misc";

/** One colour per state, everywhere it appears. */
const BOOKING_TONE: Record<BookingStatus, string> = {
  DRAFT: "bg-dead/15 text-dead",
  HELD: "bg-held/15 text-held",
  PENDING_PAYMENT: "bg-pending/15 text-pending",
  CONFIRMED: "bg-confirmed/15 text-confirmed",
  COMPLETED: "bg-completed/15 text-completed",
  EXPIRED: "bg-dead/15 text-dead",
  FAILED: "bg-destructive/15 text-destructive",
  CANCELLED: "bg-dead/15 text-dead",
  REFUNDED: "bg-refunded/15 text-refunded",
};

const LABEL: Record<BookingStatus, string> = {
  DRAFT: "Draft",
  HELD: "Held",
  PENDING_PAYMENT: "Paying",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  EXPIRED: "Expired",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

export function StatusBadge({
  status,
  className,
}: {
  status: BookingStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        BOOKING_TONE[status],
        className,
      )}
    >
      {LABEL[status] ?? status}
    </span>
  );
}

const PAYMENT_TONE: Record<PaymentStatus, string> = {
  PENDING: "bg-pending/15 text-pending",
  CAPTURED: "bg-confirmed/15 text-confirmed",
  FAILED: "bg-destructive/15 text-destructive",
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        PAYMENT_TONE[status],
      )}
    >
      {status === "CAPTURED" ? "Captured" : status === "PENDING" ? "In flight" : "Failed"}
    </span>
  );
}

export const Money = ({
  minor,
  currency,
  className,
}: {
  minor: number;
  currency?: string;
  className?: string;
}) => <span className={cn("tnum", className)}>{money(minor, currency)}</span>;

export const VenueTime = ({
  iso,
  timezone,
  className,
}: {
  iso: string;
  timezone?: string;
  className?: string;
}) => <span className={cn("tnum", className)}>{venueTime(iso, timezone)}</span>;

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center">
      <Inbox className="size-7 text-muted-foreground" />
      <div>
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * Errors name the correlation id. It is on the response and on the server log
 * line that produced it, so a screenshot is enough to find the request.
 */
export function ErrorState({ error }: { error: unknown }) {
  const id = error instanceof ApiError ? error.correlationId : undefined;
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="font-medium">{explain(error)}</p>
      {id && (
        <p className="font-mono text-xs text-muted-foreground">correlation {id}</p>
      )}
    </div>
  );
}

export const ListSkeleton = ({ rows = 5 }: { rows?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-14 w-full" />
    ))}
  </div>
);

export const CardSkeleton = ({ cards = 6 }: { cards?: number }) => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {Array.from({ length: cards }, (_, i) => (
      <Skeleton key={i} className="h-44 w-full" />
    ))}
  </div>
);

/** A label above a value. The console is mostly these. */
export const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd className="mt-1 text-sm">{children}</dd>
  </div>
);
