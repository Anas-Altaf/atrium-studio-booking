"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { RefundTier } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The tiers as the booking holds them, with the band that applies right now
 * marked. Same rule the server uses: the first band, ordered by `hours_before`
 * descending, that the remaining time still clears.
 */
export function bandFor(
  tiers: RefundTier[],
  startAt: string,
  now = Date.now(),
): RefundTier | null {
  const hoursUntil = (Date.parse(startAt) - now) / 3_600_000;
  return (
    [...tiers]
      .sort((a, b) => b.hours_before - a.hours_before)
      .find((t) => hoursUntil >= t.hours_before) ?? null
  );
}

const bandLabel = (hours: number) =>
  hours === 0 ? "Under the last band" : `More than ${hours}h before`;

export function RefundTerms({
  tiers,
  startAt,
}: {
  tiers: RefundTier[];
  startAt: string;
}) {
  const applies = bandFor(tiers, startAt);
  const ordered = [...tiers].sort((a, b) => b.hours_before - a.hours_before);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cancelled</TableHead>
          <TableHead className="text-right">Room</TableHead>
          <TableHead className="text-right">Equipment</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((tier) => {
          const active = applies?.hours_before === tier.hours_before;
          return (
            <TableRow
              key={tier.hours_before}
              className={cn(active && "bg-primary/8")}
            >
              <TableCell className={cn(active && "font-medium")}>
                {bandLabel(tier.hours_before)}
                {active && (
                  <span className="ml-2 text-xs text-primary">applies now</span>
                )}
              </TableCell>
              <TableCell className="tnum text-right">{tier.room_pct}%</TableCell>
              <TableCell className="tnum text-right">
                {tier.equipment_pct}%
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
