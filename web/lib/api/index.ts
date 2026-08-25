/** One function per endpoint. Nothing here decides who may call it — the API does. */
import { request, requestRaw } from "./client";
import type {
  Availability,
  AuditRow,
  Booking,
  BookingDetail,
  BookingListRow,
  BookingStatus,
  Cancellation,
  EquipmentAdminRow,
  EquipmentOffer,
  Health,
  OperatingHours,
  PaymentAccepted,
  Profile,
  PublishedPolicy,
  Reconciliation,
  RefundTier,
  Revenue,
  Role,
  RoomAdminRow,
  RoomDetail,
  RoomSearchRow,
  SessionUser,
  StaffRow,
  Venue,
  VenueListRow,
} from "./types";

const qs = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

export const auth = {
  login: (email: string, password: string) =>
    request<{ token: string; user: SessionUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
      anonymous: true,
    }),

  register: (email: string, password: string) =>
    request<{ token: string; user: SessionUser }>("/auth/register", {
      method: "POST",
      body: { email, password },
      anonymous: true,
    }),

  me: () => request<Profile>("/auth/me"),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: boolean }>("/auth/password", {
      method: "PATCH",
      body: { currentPassword, newPassword },
    }),
};

export interface RoomSearchParams {
  city?: string;
  minCapacity?: number;
  maxPriceMinor?: number;
  amenities?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export const rooms = {
  search: (p: RoomSearchParams) =>
    request<RoomSearchRow[]>(
      "/rooms" +
        qs({
          city: p.city,
          minCapacity: p.minCapacity,
          maxPriceMinor: p.maxPriceMinor,
          amenities: p.amenities?.length ? p.amenities.join(",") : undefined,
          from: p.from,
          to: p.to,
          limit: p.limit ?? 50,
        }),
    ),

  facets: () => request<{ cities: string[]; amenities: string[] }>("/rooms/facets"),

  get: (id: string) => request<RoomDetail>(`/rooms/${id}`),

  equipment: (id: string) => request<EquipmentOffer[]>(`/rooms/${id}/equipment`),

  availability: (id: string, from: string, to: string) =>
    request<Availability>(`/rooms/${id}/availability` + qs({ from, to })),

  update: (id: string, patch: Partial<RoomInput> & { active?: boolean }) =>
    request<RoomAdminRow>(`/rooms/${id}`, { method: "PATCH", body: patch }),
};

export interface RoomInput {
  name: string;
  capacity: number;
  hourlyRateMinor: number;
  amenities: string[];
  minDurationMin: number;
  maxDurationMin: number;
}

export interface EquipmentInput {
  name: string;
  hourlyRateMinor: number;
  unitsOwned: number;
  overbookingBuffer: number;
}

export interface VenueInput {
  name: string;
  city: string;
  timezone: string;
  operatingHours: OperatingHours;
}

export const venues = {
  list: (city?: string) => request<VenueListRow[]>("/venues" + qs({ city })),

  get: (id: string) => request<Venue>(`/venues/${id}`),

  create: (body: VenueInput) =>
    request<Venue>("/venues", { method: "POST", body }),

  update: (id: string, patch: Partial<VenueInput>) =>
    request<Venue>(`/venues/${id}`, { method: "PATCH", body: patch }),

  rooms: (id: string) => request<RoomAdminRow[]>(`/venues/${id}/rooms`),

  addRoom: (id: string, body: RoomInput) =>
    request<RoomAdminRow>(`/venues/${id}/rooms`, { method: "POST", body }),

  equipment: (id: string) => request<EquipmentAdminRow[]>(`/venues/${id}/equipment`),

  addEquipment: (id: string, body: EquipmentInput) =>
    request<EquipmentAdminRow>(`/venues/${id}/equipment`, { method: "POST", body }),

  staff: (id: string) => request<StaffRow[]>(`/venues/${id}/staff`),

  addStaff: (id: string, body: { email: string; password: string; role: Role }) =>
    request<StaffRow>(`/venues/${id}/staff`, { method: "POST", body }),

  updateStaff: (id: string, userId: string, patch: { role?: Role; active?: boolean }) =>
    request<StaffRow>(`/venues/${id}/staff/${userId}`, { method: "PATCH", body: patch }),

  policy: (id: string) => request<PublishedPolicy>(`/venues/${id}/policy`),

  publishPolicy: (id: string, tiers: RefundTier[]) =>
    request<{ venueId: string; policyVersionId: string; tiers: RefundTier[] }>(
      `/venues/${id}/policy`,
      { method: "PATCH", body: { tiers } },
    ),
};

export const equipment = {
  update: (id: string, patch: Partial<EquipmentInput> & { active?: boolean }) =>
    request<EquipmentAdminRow>(`/equipment/${id}`, { method: "PATCH", body: patch }),
};

export interface BookingFilter {
  status?: BookingStatus[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const bookings = {
  list: (f: BookingFilter = {}) =>
    request<BookingListRow[]>(
      "/bookings" +
        qs({
          status: f.status?.length ? f.status.join(",") : undefined,
          from: f.from,
          to: f.to,
          limit: f.limit ?? 20,
          offset: f.offset ?? 0,
        }),
    ),

  get: (id: string) => request<BookingDetail>(`/bookings/${id}`),

  audit: (id: string) => request<AuditRow[]>(`/bookings/${id}/audit`),

  hold: (body: {
    roomId: string;
    startAt: string;
    endAt: string;
    equipment: { equipmentTypeId: string; quantity: number }[];
  }) => request<Booking>("/bookings/hold", { method: "POST", body }),

  checkout: (id: string) =>
    request<{ bookingId: string; expiresAt: string; windowMinutes: number }>(
      `/bookings/${id}/checkout`,
      { method: "POST" },
    ),

  /** 202 created the charge, 200 found one that already existed. Both succeed. */
  pay: async (id: string): Promise<PaymentAccepted> => {
    const { status, body } = await requestRaw<Omit<PaymentAccepted, "created">>(
      `/bookings/${id}/pay`,
      { method: "POST" },
    );
    return { ...body, created: status === 202 };
  },

  cancel: (id: string) =>
    request<Cancellation>(`/bookings/${id}/cancel`, { method: "POST" }),
};

export const reports = {
  reconciliation: () => request<Reconciliation>("/reports/reconciliation"),

  revenue: (venueId: string, from: string, to: string) =>
    request<Revenue>("/reports/revenue" + qs({ venueId, from, to })),
};

export const system = {
  health: () => request<Health>("/health", { anonymous: true }),
};

export * from "./types";
export { ApiError, API_BASE, explain, tokenStore, onUnauthorized } from "./client";
