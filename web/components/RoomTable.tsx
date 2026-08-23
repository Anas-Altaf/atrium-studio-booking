"use client";

import type { Room } from "@/lib/api";

/**
 * Venue ids are shown, shortened, on purpose. The number of distinct venues in
 * this list is the visible difference between a customer searching across the
 * platform and a venue admin who can only ever see their own.
 */
export default function RoomTable({
  rooms,
  selectedId,
  onSelect,
}: {
  rooms: Room[];
  selectedId: string | null;
  onSelect: (room: Room) => void;
}) {
  if (rooms.length === 0) {
    return (
      <p className="text-sm opacity-60">
        No rooms free for that slot. Widen the filters or move the time.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left opacity-60">
            <th className="py-2 pr-3 font-medium">Room</th>
            <th className="py-2 pr-3 font-medium">City</th>
            <th className="py-2 pr-3 text-right font-medium">Cap</th>
            <th className="py-2 pr-3 text-right font-medium">Rate/hr</th>
            <th className="py-2 font-medium">Venue</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => {
            const selected = room.id === selectedId;
            return (
              <tr
                key={room.id}
                onClick={() => onSelect(room)}
                className={`cursor-pointer border-t border-black/5 dark:border-white/10 ${
                  selected
                    ? "bg-blue-50 dark:bg-blue-950/40"
                    : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <td className="py-2 pr-3">
                  {selected && <span className="mr-1 text-blue-600">→</span>}
                  {room.name}
                </td>
                <td className="py-2 pr-3 opacity-70">{room.city}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {room.capacity}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {(room.hourly_rate_minor / 100).toLocaleString()}
                </td>
                <td className="py-2 font-mono text-xs opacity-50">
                  {room.venue_id.slice(0, 8)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
