"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { venues, type VenueListRow } from "./api";
import { keys } from "./query-keys";
import { useAuth } from "./auth-context";

/**
 * Which venue the console is looking at.
 *
 * A venue-scoped account has exactly one and cannot change it — the API would
 * refuse anything else anyway. A platform admin has every venue and has to pick,
 * so the choice is remembered between visits.
 */
interface VenueState {
  venueId: string | null;
  choices: VenueListRow[];
  /** True only for a platform admin, who is the only role with a choice. */
  switchable: boolean;
  setVenueId: (id: string) => void;
  loading: boolean;
}

const Ctx = React.createContext<VenueState | null>(null);
const STORE_KEY = "atrium.venue";

export function VenueProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  const switchable = profile?.role === "PLATFORM_ADMIN";

  const { data, isPending } = useQuery({
    queryKey: keys.venueList(),
    queryFn: () => venues.list(),
    enabled: !!profile,
    staleTime: 5 * 60_000,
  });

  const [chosen, setChosen] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!switchable) return;
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) setChosen(saved);
  }, [switchable]);

  const venueId = switchable
    ? (chosen && data?.some((v) => v.id === chosen) ? chosen : data?.[0]?.id ?? null)
    : profile?.venueId ?? null;

  const value: VenueState = {
    venueId,
    choices: data ?? [],
    switchable: !!switchable,
    loading: isPending && !!profile,
    setVenueId: (id) => {
      localStorage.setItem(STORE_KEY, id);
      setChosen(id);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVenue(): VenueState {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useVenue outside VenueProvider");
  return ctx;
}
