"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { rooms, type RoomSearchParams } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { money } from "@/lib/format";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
} from "@/components/atoms";
import { SearchFilters, type Filters } from "@/components/search-filters";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Filters live in the URL, so a search is a link and the back button works.
 * That also makes the query key a function of the URL and nothing else.
 */
export default function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();

  const filters: Filters = {
    city: params.get("city") ?? "",
    minCapacity: params.get("minCapacity") ?? "",
    maxPriceMinor: params.get("maxPriceMinor") ?? "",
    amenities: params.get("amenities")?.split(",").filter(Boolean) ?? [],
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };

  const query: RoomSearchParams = {
    city: filters.city || undefined,
    minCapacity: filters.minCapacity ? Number(filters.minCapacity) : undefined,
    maxPriceMinor: filters.maxPriceMinor ? Number(filters.maxPriceMinor) : undefined,
    amenities: filters.amenities.length ? filters.amenities : undefined,
    // The API refuses one end of a window without the other.
    from: filters.from && filters.to ? filters.from : undefined,
    to: filters.from && filters.to ? filters.to : undefined,
    limit: 60,
  };

  const { data, isPending, error } = useQuery({
    queryKey: keys.roomSearch(query),
    queryFn: () => rooms.search(query),
  });

  function apply(next: Filters) {
    const search = new URLSearchParams();
    if (next.city) search.set("city", next.city);
    if (next.minCapacity) search.set("minCapacity", next.minCapacity);
    if (next.maxPriceMinor) search.set("maxPriceMinor", next.maxPriceMinor);
    if (next.amenities.length) search.set("amenities", next.amenities.join(","));
    if (next.from && next.to) {
      search.set("from", next.from);
      search.set("to", next.to);
    }
    router.replace(`/search?${search.toString()}`);
  }

  return (
    <>
      <PageHeader
        title="Find a room"
        description="City, capacity, price, amenities and a free window — all at once."
      />

      <SearchFilters value={filters} onChange={apply} />

      <div className="mt-6">
        {isPending ? (
          <CardSkeleton />
        ) : error ? (
          <ErrorState error={error} />
        ) : data.length === 0 ? (
          <EmptyState
            title="No rooms match those filters"
            hint="Widen the price ceiling, drop an amenity, or move the window."
          />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {data.length} room{data.length === 1 ? "" : "s"}
              {query.from ? " free for that window" : ""}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.map((room) => (
                <Link
                  key={room.id}
                  href={
                    query.from
                      ? `/rooms/${room.id}?from=${encodeURIComponent(query.from)}`
                      : `/rooms/${room.id}`
                  }
                  className="group"
                >
                  <Card className="h-full transition-colors group-hover:border-primary/50">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{room.name}</p>
                          <p className="text-sm text-muted-foreground">{room.city}</p>
                        </div>
                        <p className="shrink-0 text-right text-sm">
                          <span className="tnum font-medium">
                            {money(room.hourly_rate_minor)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            per hour
                          </span>
                        </p>
                      </div>

                      <div className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Users className="size-3.5" />
                        seats {room.capacity}
                      </div>

                      {room.amenities.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-1.5">
                          {room.amenities.slice(0, 4).map((a) => (
                            <Badge key={a} variant="secondary">
                              {a}
                            </Badge>
                          ))}
                          {room.amenities.length > 4 && (
                            <Badge variant="outline">
                              +{room.amenities.length - 4}
                            </Badge>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
