-- 003  Bookings, equipment line items, and the room exclusion constraint.

-- A generated column must be IMMUTABLE. The timestamptz + interval operator is
-- only STABLE, because in the general case it does month and day arithmetic
-- that depends on the session TimeZone across a DST boundary. A fixed 15 minute
-- interval does none of that: it is exact microsecond arithmetic on the epoch
-- value, with no timezone involved. Wrapping it in a function marked IMMUTABLE
-- is therefore accurate rather than a workaround, and it is what lets the
-- turnaround gap live in the geometry instead of in a validation branch.
--
-- Written inline first and rejected by Postgres on the first real migration run
-- with 'generation expression is not immutable'. See AI_LOG entry 15.
CREATE FUNCTION booking_reserved_range(start_at timestamptz, end_at timestamptz)
RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT tstzrange($1, $2 + interval '15 minutes', '[)')
$fn$;

CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          uuid           NOT NULL REFERENCES venues(id),
  room_id           uuid           NOT NULL REFERENCES rooms(id),
  user_id           uuid           NOT NULL REFERENCES users(id),
  status            booking_status NOT NULL DEFAULT 'DRAFT',
  start_at          timestamptz    NOT NULL,
  end_at            timestamptz    NOT NULL,

  -- The 15 minute turnaround is part of the geometry, not a validation branch.
  -- Range overlap is mutual, so extending only the tail enforces the gap on
  -- both sides, and no code path can bypass it. See ARCHITECTURE.md 3.1.
  reserved_range    tstzrange GENERATED ALWAYS AS (
                      booking_reserved_range(start_at, end_at)
                    ) STORED,

  expires_at        timestamptz,
  policy_version_id uuid   NOT NULL REFERENCES refund_policy_versions(id),
  total_minor       bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT end_after_start CHECK (end_at > start_at),
  CONSTRAINT duration_bounds CHECK (
    end_at - start_at BETWEEN interval '1 hour' AND interval '8 hours'
  ),
  CONSTRAINT half_hour_granularity CHECK (
    EXTRACT(EPOCH FROM start_at)::bigint % 1800 = 0 AND
    EXTRACT(EPOCH FROM end_at)::bigint   % 1800 = 0
  ),
  CONSTRAINT held_has_expiry CHECK (status <> 'HELD' OR expires_at IS NOT NULL)
);

-- INV-1. The check and the write are the same operation, so there is no window
-- between them. Two concurrent overlapping inserts cannot both commit: the
-- second blocks on the index entry until the first resolves, then raises 23P01.
-- Enforced by the index, so it holds against any client and any replica count.
ALTER TABLE bookings ADD CONSTRAINT no_room_overlap
  EXCLUDE USING gist (room_id WITH =, reserved_range WITH &&)
  WHERE (status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED'));

CREATE TABLE booking_line_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid   NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  equipment_type_id uuid   NOT NULL REFERENCES equipment_types(id),
  quantity          int    NOT NULL CHECK (quantity > 0),
  hourly_rate_minor bigint NOT NULL CHECK (hourly_rate_minor >= 0),
  UNIQUE (booking_id, equipment_type_id)
);
