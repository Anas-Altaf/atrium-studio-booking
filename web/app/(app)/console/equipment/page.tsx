"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import {
  equipment as equipmentApi,
  explain,
  venues,
  type EquipmentAdminRow,
} from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { money } from "@/lib/format";
import {
  EmptyState,
  ErrorState,
  ListSkeleton,
  PageHeader,
} from "@/components/atoms";
import { WithVenue, useCanWrite } from "@/components/console/console-gate";
import { EquipmentForm } from "@/components/console/equipment-form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function ConsoleEquipmentPage() {
  return <WithVenue>{(venueId) => <EquipmentTable venueId={venueId} />}</WithVenue>;
}

function EquipmentTable({ venueId }: { venueId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<EquipmentAdminRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: keys.venueEquipment(venueId),
    queryFn: () => venues.equipment(venueId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.venueEquipment(venueId) });
    void queryClient.invalidateQueries({ queryKey: keys.rooms });
  };

  const archive = useMutation({
    mutationFn: (item: EquipmentAdminRow) =>
      equipmentApi.update(item.id, { active: !item.active }),
    onSuccess: (item) => {
      invalidate();
      toast.success(item.active ? "Back in the catalogue." : "Equipment archived.");
    },
    onError: (err) => toast.error(explain(err)),
  });

  return (
    <>
      <PageHeader
        title="Equipment"
        description="Booked as a quantity over an interval, never as a stock column."
        actions={
          canWrite && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Add equipment
            </Button>
          )
        }
      />

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} />
      ) : data.length === 0 ? (
        <EmptyState
          title="No equipment yet"
          hint="Customers can still book rooms without it."
          action={canWrite && <Button onClick={() => setCreating(true)}>Add the first item</Button>}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Units owned</TableHead>
                <TableHead className="text-right">Buffer</TableHead>
                <TableHead className="text-right">Effective</TableHead>
                <TableHead className="text-right">Rate / h</TableHead>
                {canWrite && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((item) => {
                const buffer = Number(item.overbooking_buffer);
                return (
                  <TableRow key={item.id} className={item.active ? "" : "opacity-55"}>
                    <TableCell>
                      <span className="font-medium">{item.name}</span>
                      {!item.active && (
                        <Badge variant="outline" className="ml-2">
                          archived
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tnum text-right">
                      {item.units_owned}
                    </TableCell>
                    <TableCell className="tnum text-right text-muted-foreground">
                      {(buffer * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="tnum text-right">
                      {Math.floor(item.units_owned * (1 + buffer))}
                    </TableCell>
                    <TableCell className="tnum text-right">
                      {money(item.hourly_rate_minor)}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="whitespace-nowrap text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(item)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => archive.mutate(item)}
                        >
                          {item.active ? "Archive" : "Restore"}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Effective capacity is units owned plus the buffer, floored — 10% of one
        unit is nothing, which is why the buffer never applies to rooms. Cutting
        units below what future bookings already hold is refused.
      </p>

      {creating && (
        <EquipmentForm
          venueId={venueId}
          onDone={() => {
            setCreating(false);
            invalidate();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {editing && (
        <EquipmentForm
          venueId={venueId}
          item={editing}
          onDone={() => {
            setEditing(null);
            invalidate();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}
