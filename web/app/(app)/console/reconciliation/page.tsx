"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { reports } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { ErrorState, Money, PageHeader } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const KIND_COPY: Record<string, string> = {
  CAPTURE_WITHOUT_OUTCOME: "Money taken for a booking that neither happened nor was refunded",
  CONFIRMED_WITHOUT_CAPTURE: "A booking that happened with no captured charge",
  REFUND_WITHOUT_CAPTURE: "A refund against a charge that was never captured",
  UNMATCHED_CALLBACK: "A callback naming a charge that was never recorded",
};

export default function ReconciliationPage() {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: keys.reconciliation,
    queryFn: reports.reconciliation,
  });

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="INV-5, as a query anyone can run rather than a claim in a document."
        actions={
          <Button
            size="sm"
            variant="outline"
            loading={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw />
            Re-run
          </Button>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="p-5">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Captured
                </p>
                <p className="tnum mt-1 text-xl font-semibold">
                  <Money minor={data.tally.captured_minor} />
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Refunded
                </p>
                <p className="tnum mt-1 text-xl font-semibold">
                  <Money minor={data.tally.refunded_minor} />
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Confirmed bookings
                </p>
                <p className="tnum mt-1 text-xl font-semibold">
                  {data.tally.confirmed_bookings}
                </p>
              </CardContent>
            </Card>
          </div>

          {data.count === 0 ? (
            <Card className="mt-6 border-confirmed/40 bg-confirmed/5">
              <CardContent className="flex items-center gap-3 p-6">
                <CheckCircle2 className="size-6 shrink-0 text-confirmed" />
                <div>
                  <p className="font-medium text-confirmed">Zero discrepancies</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Every captured charge maps to a confirmed booking or a refund,
                    every confirmed booking has a captured charge, and every refund
                    has a capture behind it.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-destructive">
                  {data.count} discrepanc{data.count === 1 ? "y" : "ies"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What</TableHead>
                      <TableHead>Record</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.discrepancies.map((d) => (
                      <TableRow key={`${d.kind}-${d.id}`}>
                        <TableCell>
                          <span className="font-medium">{d.kind}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {KIND_COPY[d.kind]}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{d.id}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {d.detail}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
