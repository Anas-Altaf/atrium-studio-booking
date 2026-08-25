/** Row shapes returned by the API. Mapped separately when the wire format diverges from the storage format. */

export interface BookingRow {
  id: string;
  venue_id: string;
  room_id: string;
  user_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  expires_at: Date | null;
  policy_version_id: string;
  total_minor: number;
}

export interface RoomRow {
  id: string;
  venue_id: string;
  capacity: number;
  hourly_rate_minor: number;
  min_duration_min: number;
  max_duration_min: number;
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

export interface EquipmentTypeRow {
  id: string;
  venue_id: string;
  hourly_rate_minor: number;
  units_owned: number;
  /** numeric(4,3) — node-postgres hands this back as a string. */
  overbooking_buffer: string;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  venue_id: string | null;
}

/** A venue's published hours for one weekday, as stored in `operating_hours`. */
export type OperatingHours = Record<string, [string, string][]>;

/** The venue's local view of a requested interval, resolved by Postgres. */
export interface LocalWindow {
  dow: string;
  local_start: string;
  local_end: string;
  hours: OperatingHours | null;
}

export interface EquipmentLine {
  equipmentTypeId: string;
  quantity: number;
}

/** A line item as stored — the rate is frozen at hold, not read back live. */
export interface EquipmentLineItem {
  equipment_type_id: string;
  quantity: number;
  hourly_rate_minor: number;
}

/** One band of a refund policy version. Ordered by hours_before descending. */
export interface RefundTier {
  hours_before: number;
  room_pct: number;
  equipment_pct: number;
}

export interface HoldRequest {
  roomId: string;
  startAt: string;
  endAt: string;
  equipment: EquipmentLine[];
}

export interface RoomSearch {
  city?: string;
  minCapacity?: number;
  maxPriceMinor?: number;
  amenities?: string[];
  from?: string;
  to?: string;
  limit: number;
}
