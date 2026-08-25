"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { explain, venues, type RefundTier } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { venueTime } from "@/lib/format";
import { ErrorState, PageHeader } from "@/components/atoms";
import { WithVenue, useCanWrite } from "@/components/console/console-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export default function PolicyPage() {
  return <WithVenue>{(venueId) => <PolicyEditor venueId={venueId} />}</WithVenue>;
}

const PLATFORM_DEFAULT: RefundTier[] = [
  { hours_before: 48, room_pct: 100, equipment_pct: 100 },
  { hours_before: 24, room_pct: 50, equipment_pct: 100 },
  { hours_before: 2, room_pct: 0, equipment_pct: 100 },
  { hours_before: 0, room_pct: 0, equipment_pct: 0 },
];

function PolicyEditor({ venueId }: { venueId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: keys.venuePolicy(venueId),
    queryFn: () => venues.policy(venueId),
  });

  const [tiers, setTiers] = React.useState<RefundTier[] | null>(null);
  const working = tiers ?? data?.tiers ?? [];

  const publish = useMutation({
    mutationFn: () => venues.publishPolicy(venueId, working),
    onSuccess: () => {
      toast.success("New terms published. Existing bookings keep their own.");
      setTiers(null);
      void queryClient.invalidateQueries({ queryKey: keys.venuePolicy(venueId) });
    },
    onError: (err) => toast.error(explain(err)),
  });

  const set = (i: number, patch: Partial<RefundTier>) =>
    setTiers(working.map((t, j) => (i === j ? { ...t, ...patch } : t)));

  const hasZeroBand = working.some((t) => t.hours_before === 0);
  const duplicates =
    new Set(working.map((t) => t.hours_before)).size !== working.length;
  const dirty = tiers !== null;

  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader
        title="Refund policy"
        description="Policy is data. A change takes effect immediately, with no deployment."
        actions={
          canWrite && (
            <Button
              size="sm"
              loading={publish.isPending}
              disabled={!dirty || !hasZeroBand || duplicates}
              onClick={() => publish.mutate()}
            >
              Publish
            </Button>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Bands</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Read top down: the first band whose threshold the remaining time
              still clears is the one that applies.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                  <span>Hours before</span>
                  <span>Room %</span>
                  <span>Equipment %</span>
                  <span className="w-9" />
                </div>

                {[...working]
                  .sort((a, b) => b.hours_before - a.hours_before)
                  .map((tier) => {
                    const i = working.indexOf(tier);
                    return (
                      <div
                        key={i}
                        className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-3"
                      >
                        <Input
                          type="number"
                          min={0}
                          disabled={!canWrite}
                          value={tier.hours_before}
                          onChange={(e) =>
                            set(i, { hours_before: Number(e.target.value) })
                          }
                        />
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          disabled={!canWrite}
                          value={tier.room_pct}
                          onChange={(e) => set(i, { room_pct: Number(e.target.value) })}
                        />
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          disabled={!canWrite}
                          value={tier.equipment_pct}
                          onChange={(e) =>
                            set(i, { equipment_pct: Number(e.target.value) })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!canWrite || working.length === 1}
                          onClick={() =>
                            setTiers(working.filter((_, j) => j !== i))
                          }
                          aria-label="Remove band"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    );
                  })}

                {canWrite && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTiers([
                          ...working,
                          { hours_before: 12, room_pct: 25, equipment_pct: 50 },
                        ])
                      }
                    >
                      <Plus />
                      Add band
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setTiers(PLATFORM_DEFAULT)}
                    >
                      Reset to the platform default
                    </Button>
                  </div>
                )}

                {!hasZeroBand && (
                  <p className="text-sm text-destructive">
                    A band at 0 hours is required — without it the last hours
                    before a booking would refund nothing by accident rather than
                    by decision.
                  </p>
                )}
                {duplicates && (
                  <p className="text-sm text-destructive">
                    Two bands share the same threshold.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Current version</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data ? (
                <>
                  <p className="font-mono text-xs text-muted-foreground">
                    {data.policy_version_id}
                  </p>
                  <p className="text-muted-foreground">
                    published {venueTime(data.published_at)}
                  </p>
                </>
              ) : (
                <Skeleton className="h-10 w-full" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              Versions are immutable. Publishing inserts a new one and moves the
              venue&apos;s pointer; every booking keeps the version that was in
              force when it was made, so a change here cannot reach terms a
              customer already agreed to.
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
