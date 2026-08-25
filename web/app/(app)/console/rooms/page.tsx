"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { explain, rooms as roomsApi, venues, type RoomAdminRow } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { money } from "@/lib/format";
import { durationLabel } from "@/lib/slots";
import {
  EmptyState,
  ErrorState,
  ListSkeleton,
  PageHeader,
} from "@/components/atoms";
import { WithVenue, useCanWrite } from "@/components/console/console-gate";
import { RoomForm } from "@/components/console/room-form";
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

export default function ConsoleRoomsPage() {
  return <WithVenue>{(venueId) => <RoomsTable venueId={venueId} />}</WithVenue>;
}

function RoomsTable({ venueId }: { venueId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<RoomAdminRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: keys.venueRooms(venueId),
    queryFn: () => venues.rooms(venueId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.venueRooms(venueId) });
    // The catalogue a customer searches changed too.
    void queryClient.invalidateQueries({ queryKey: keys.rooms });
  };

  const archive = useMutation({
    mutationFn: (room: RoomAdminRow) =>
      roomsApi.update(room.id, { active: !room.active }),
    onSuccess: (room) => {
      invalidate();
      toast.success(room.active ? "Room is live again." : "Room archived.");
    },
    onError: (err) => toast.error(explain(err)),
  });

  return (
    <>
      <PageHeader
        title="Rooms"
        description="A rate change reaches new bookings only — existing ones froze their price at the hold."
        actions={
          canWrite && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Add room
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
          title="No rooms yet"
          hint="A venue with no rooms cannot be booked."
          action={
            canWrite && <Button onClick={() => setCreating(true)}>Add the first room</Button>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead className="text-right">Seats</TableHead>
                <TableHead className="text-right">Rate / h</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Amenities</TableHead>
                {canWrite && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((room) => (
                <TableRow key={room.id} className={room.active ? "" : "opacity-55"}>
                  <TableCell>
                    <span className="font-medium">{room.name}</span>
                    {!room.active && (
                      <Badge variant="outline" className="ml-2">
                        archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tnum text-right">{room.capacity}</TableCell>
                  <TableCell className="tnum text-right">
                    {money(room.hourly_rate_minor)}
                  </TableCell>
                  <TableCell className="tnum whitespace-nowrap text-muted-foreground">
                    {durationLabel(room.min_duration_min)} –{" "}
                    {durationLabel(room.max_duration_min)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {room.amenities.slice(0, 3).map((a) => (
                        <Badge key={a} variant="secondary">
                          {a}
                        </Badge>
                      ))}
                      {room.amenities.length > 3 && (
                        <Badge variant="outline">+{room.amenities.length - 3}</Badge>
                      )}
                    </span>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(room)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => archive.mutate(room)}
                      >
                        {room.active ? "Archive" : "Restore"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Rooms are archived, never deleted: bookings and their audit history point
        at them. An archived room keeps its past and takes no new bookings.
      </p>

      {creating && (
        <RoomForm
          venueId={venueId}
          onDone={() => {
            setCreating(false);
            invalidate();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {editing && (
        <RoomForm
          venueId={venueId}
          room={editing}
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
