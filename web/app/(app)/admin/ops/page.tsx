"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { API_BASE, system } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { ErrorState, Field, PageHeader } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function OpsPage() {
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: keys.health,
    queryFn: system.health,
    refetchInterval: 15_000,
  });

  return (
    <>
      <PageHeader
        title="Ops"
        description="The health check counts applied migrations — a replica pointed at an unmigrated database looks fine and answers every request with a 500."
        actions={
          <Button size="sm" variant="outline" loading={isFetching} onClick={() => refetch()}>
            <RefreshCw />
            Check now
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" />
              API
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <ErrorState error={error} />
            ) : isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="Status">
                  <span
                    className={
                      data.status === "ok" ? "text-confirmed" : "text-destructive"
                    }
                  >
                    {data.status}
                  </span>
                </Field>
                <Field label="Database">{data.database}</Field>
                <Field label="Replica">
                  <span className="font-mono text-xs">{data.instance}</span>
                </Field>
                <Field label="Migrations applied">
                  <span className="tnum">{data.migrationsApplied ?? "—"}</span>
                </Field>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where this is pointed</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4">
              <Field label="API base">
                <span className="font-mono text-xs break-all">{API_BASE}</span>
              </Field>
              <Field label="Load balancing">
                Under docker compose the replica name changes between checks —
                three API instances sit behind nginx, and every invariant has to
                hold across all of them.
              </Field>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
