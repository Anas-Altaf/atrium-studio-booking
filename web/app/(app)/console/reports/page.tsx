"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { reports } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { isoDayOffset, money, moneyShort } from "@/lib/format";
import { EmptyState, ErrorState, Money, PageHeader } from "@/components/atoms";
import { WithVenue } from "@/components/console/console-gate";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function ReportsPage() {
  return <WithVenue>{(venueId) => <Revenue venueId={venueId} />}</WithVenue>;
}

const RANGES = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last year"],
] as const;

function Revenue({ venueId }: { venueId: string }) {
  const [days, setDays] = React.useState("30");

  const from = isoDayOffset(-Number(days));
  const to = isoDayOffset(1);

  const { data, isPending, error } = useQuery({
    queryKey: keys.revenue(venueId, from, to),
    queryFn: () => reports.revenue(venueId, from, to),
  });

  return (
    <>
      <PageHeader
        title="Revenue and utilisation"
        description="Gross is money the provider captured, not the sum of booking totals."
        actions={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gross captured" value={money(data.revenue.grossMinor)} />
            <Stat
              label="Refunded"
              value={money(data.revenue.refundedMinor)}
              tone="muted"
            />
            <Stat label="Net" value={money(data.revenue.netMinor)} emphasis />
            <Stat
              label="Utilisation"
              value={`${data.utilisation.pct}%`}
              hint={`${data.utilisation.bookedHours}h booked of ${Math.round(
                data.utilisation.openHours,
              )}h open across ${data.utilisation.rooms} rooms`}
            />
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>By room</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Booked value of confirmed and completed bookings, in the venue&apos;s
                own currency.
              </p>
            </CardHeader>
            <CardContent>
              {data.byRoom.length === 0 ? (
                <EmptyState title="No bookings in this range" />
              ) : (
                <>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={data.byRoom.slice(0, 12).map((r) => ({
                          name: r.room_name,
                          value: r.gross_minor / 100,
                        }))}
                        margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--border)"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v) => moneyShort(v * 100)}
                        />
                        <Tooltip
                          cursor={{ fill: "var(--accent)" }}
                          contentStyle={{
                            background: "var(--popover)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(v) => money(Number(v ?? 0) * 100)}
                        />
                        <Bar
                          dataKey="value"
                          fill="var(--primary)"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Room</TableHead>
                        <TableHead className="text-right">Bookings</TableHead>
                        <TableHead className="text-right">Hours</TableHead>
                        <TableHead className="text-right">Booked value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byRoom.map((r) => (
                        <TableRow key={r.room_id}>
                          <TableCell>{r.room_name}</TableCell>
                          <TableCell className="tnum text-right">
                            {r.bookings}
                          </TableCell>
                          <TableCell className="tnum text-right">
                            {r.booked_hours.toFixed(1)}
                          </TableCell>
                          <TableCell className="tnum text-right">
                            <Money minor={r.gross_minor} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  tone?: "muted";
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={`tnum mt-1 text-2xl font-semibold ${
            emphasis ? "text-confirmed" : tone === "muted" ? "text-muted-foreground" : ""
          }`}
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
