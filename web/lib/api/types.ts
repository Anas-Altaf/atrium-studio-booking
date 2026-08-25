/** Wire shapes, mirrored from the API. Money is always minor units, always an integer. */

export type Role = "CUSTOMER" | "VENUE_STAFF" | "VENUE_ADMIN" | "PLATFORM_ADMIN";

export type BookingStatus =
  | "DRAFT"
  | "HELD"
  | "PENDING_PAYMENT"
  | "CONFIRMED"
  | "COMPLETED"
  | "EXPIRED"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export type PaymentStatus = "PENDING" | "CAPTURED" | "FAILED";
export type RefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  venueId: string | null;
}

export interface Profile {
  userId: string;
  role: Role;
  venueId: string | null;
  email: string;
  venueName: string | null;
}

export type OperatingHours = Record<string, [string, string][]>;

export interface Venue {
  id: string;
  name: string;
  city: string;
  timezone: string;
  operating_hours: OperatingHours;
}

export interface VenueListRow extends Venue {
  room_count: number;
}

export interface RoomSearchRow {
  id: string;
  venue_id: string;
  name: string;
  city: string;
  capacity: number;
  hourly_rate_minor: number;
  amenities: string[];
}

export interface RoomDetail extends RoomSearchRow {
  venue_name: string;
  min_duration_min: number;
  max_duration_min: number;
}

export interface RoomAdminRow extends RoomDetail {
  active: boolean;
}

export interface EquipmentOffer {
  id: string;
  name: string;
  hourly_rate_minor: number;
  units_owned: number;
}

export interface EquipmentAdminRow extends EquipmentOffer {
  venue_id: string;
  /** numeric(4,3) — the API hands this back as a string. */
  overbooking_buffer: string;
  active: boolean;
}

export interface StaffRow {
  id: string;
  email: string;
  role: Role;
  venue_id: string | null;
  active: boolean;
  created_at: string;
}

export interface Booking {
  id: string;
  venue_id: string;
  room_id: string;
  user_id: string;
  status: BookingStatus;
  start_at: string;
  end_at: string;
  expires_at: string | null;
  policy_version_id: string;
  total_minor: number;
}

export interface BookingListRow extends Booking {
  room_name: string;
  venue_name: string;
  city: string;
}

export interface LineItem {
  equipment_type_id: string;
  quantity: number;
  hourly_rate_minor: number;
  name: string;
}

export interface RefundTier {
  hours_before: number;
  room_pct: number;
  equipment_pct: number;
}

export interface BookingDetail extends Booking {
  room: { id: string; name: string; venue_name: string; city: string } | null;
  lineItems: LineItem[];
  payment: {
    id: string;
    status: PaymentStatus;
    amountMinor: number;
    currency: string;
  } | null;
  refund: {
    id: string;
    status: RefundStatus;
    amountMinor: number;
    reason: string;
  } | null;
  policy: { tiers: RefundTier[] };
}

export interface AuditRow {
  id: number;
  from_state: BookingStatus | null;
  to_state: BookingStatus;
  reason: string;
  occurred_at: string;
  actor_email: string | null;
}

export interface BusyInterval {
  startAt: string;
  endAt: string;
  status: BookingStatus;
}

export interface Availability {
  roomId: string;
  from: string;
  to: string;
  operatingHours: OperatingHours | null;
  busy: BusyInterval[];
}

export interface PublishedPolicy {
  policy_version_id: string;
  tiers: RefundTier[];
  published_at: string;
}

export interface Cancellation {
  bookingId: string;
  status: BookingStatus;
  refund: { id: string; amountMinor: number; status: RefundStatus } | null;
  cancelled: boolean;
}

export interface PaymentAccepted {
  paymentId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  chargeId: string | null;
  /** False when the API answered 200: a charge already existed (INV-3). */
  created: boolean;
}

export interface Discrepancy {
  kind: string;
  id: string;
  detail: string;
}

export interface Reconciliation {
  discrepancies: Discrepancy[];
  count: number;
  tally: {
    captured_minor: number;
    refunded_minor: number;
    confirmed_bookings: number;
  };
}

export interface RoomRevenue {
  room_id: string;
  room_name: string;
  bookings: number;
  gross_minor: number;
  booked_hours: number;
}

export interface Revenue {
  venueId: string;
  venueName: string;
  from: string;
  to: string;
  revenue: {
    grossMinor: number;
    refundedMinor: number;
    netMinor: number;
    paidBookings: number;
  };
  utilisation: {
    bookedHours: number;
    openHours: number;
    pct: number;
    rooms: number;
  };
  byRoom: RoomRevenue[];
}

export interface Health {
  status: "ok" | "degraded";
  instance: string;
  database: string;
  migrationsApplied?: number;
  error?: string;
}
