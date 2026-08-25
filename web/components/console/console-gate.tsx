"use client";

import * as React from "react";
import { useProfile } from "@/lib/auth-context";
import { useVenue } from "@/lib/venue-context";
import { EmptyState } from "@/components/atoms";
import { Skeleton } from "@/components/ui/misc";

/**
 * Console pages all need a venue id. A venue-scoped account has one; a platform
 * admin picks one. Until there is one, there is nothing to render.
 *
 * This is a rendering guard, not an authorisation one — reaching a page without
 * the right role still ends in a 403 or a 404 from the API.
 */
export function WithVenue({
  children,
}: {
  children: (venueId: string) => React.ReactNode;
}) {
  const { venueId, loading } = useVenue();

  if (loading) return <Skeleton className="h-72 w-full" />;
  if (!venueId) {
    return (
      <EmptyState
        title="No venue selected"
        hint="Pick one from the switcher in the top bar."
      />
    );
  }
  return <>{children(venueId)}</>;
}

/** True when this account may write to the venue it is looking at. */
export function useCanWrite(): boolean {
  const profile = useProfile();
  return profile.role === "VENUE_ADMIN" || profile.role === "PLATFORM_ADMIN";
}
