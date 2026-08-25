import type { BookingFilter, RoomSearchParams } from "./api";

/**
 * One factory, so a write invalidates exactly what it changed. Prefixes are
 * hierarchical: invalidating ["bookings"] catches every list and detail under it.
 */
export const keys = {
  me: ["me"] as const,

  rooms: ["rooms"] as const,
  roomSearch: (p: RoomSearchParams) => ["rooms", "search", p] as const,
  roomFacets: ["rooms", "facets"] as const,
  room: (id: string) => ["rooms", id] as const,
  roomEquipment: (id: string) => ["rooms", id, "equipment"] as const,
  roomAvailability: (id: string, from: string, to: string) =>
    ["rooms", id, "availability", from, to] as const,

  bookings: ["bookings"] as const,
  bookingList: (f: BookingFilter) => ["bookings", "list", f] as const,
  booking: (id: string) => ["bookings", id] as const,
  bookingAudit: (id: string) => ["bookings", id, "audit"] as const,

  venues: ["venues"] as const,
  venueList: (city?: string) => ["venues", "list", city ?? null] as const,
  venue: (id: string) => ["venues", id] as const,
  venueRooms: (id: string) => ["venues", id, "rooms"] as const,
  venueEquipment: (id: string) => ["venues", id, "equipment"] as const,
  venueStaff: (id: string) => ["venues", id, "staff"] as const,
  venuePolicy: (id: string) => ["venues", id, "policy"] as const,

  reconciliation: ["reports", "reconciliation"] as const,
  revenue: (venueId: string, from: string, to: string) =>
    ["reports", "revenue", venueId, from, to] as const,

  health: ["health"] as const,
};
