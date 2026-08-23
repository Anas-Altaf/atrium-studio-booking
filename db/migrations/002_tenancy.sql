-- 002  Venues, refund policy versions, rooms, equipment, users.

CREATE TABLE venues (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text        NOT NULL,
  city                      text        NOT NULL,
  timezone                  text        NOT NULL,   -- IANA, e.g. 'Asia/Karachi'
  operating_hours           jsonb       NOT NULL,   -- { "mon": [["09:00","22:00"]], ... }
  current_policy_version_id uuid,                   -- FK added in 003, circular
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Append-only. An admin editing tiers inserts a new version; the venue pointer
-- moves. Bookings hold the version id in force when they were created, so a
-- policy change cannot reach a booking already made. See ARCHITECTURE.md 4B.
CREATE TABLE refund_policy_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   uuid REFERENCES venues(id) ON DELETE CASCADE,  -- NULL = platform default
  tiers      jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tiers shape, ordered by hours_before descending:
--   [ { "hours_before": 48, "room_pct": 100, "equipment_pct": 100 },
--     { "hours_before": 24, "room_pct":  50, "equipment_pct": 100 },
--     { "hours_before":  2, "room_pct":   0, "equipment_pct": 100 },
--     { "hours_before":  0, "room_pct":   0, "equipment_pct":   0 } ]

ALTER TABLE venues
  ADD CONSTRAINT venues_current_policy_fk
  FOREIGN KEY (current_policy_version_id) REFERENCES refund_policy_versions(id);

CREATE TABLE rooms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          uuid   NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name              text   NOT NULL,
  capacity          int    NOT NULL CHECK (capacity > 0),
  hourly_rate_minor bigint NOT NULL CHECK (hourly_rate_minor >= 0),
  amenities         text[] NOT NULL DEFAULT '{}',
  -- denormalized from venues.city so cross-venue search filters without a join
  city              text   NOT NULL,
  min_duration_min  int    NOT NULL DEFAULT 60  CHECK (min_duration_min >= 60),
  max_duration_min  int    NOT NULL DEFAULT 480 CHECK (max_duration_min <= 480),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duration_range_sane CHECK (max_duration_min >= min_duration_min)
);

CREATE TABLE equipment_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id           uuid   NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name               text   NOT NULL,
  hourly_rate_minor  bigint NOT NULL CHECK (hourly_rate_minor >= 0),
  units_owned        int    NOT NULL CHECK (units_owned > 0),
  -- equipment only; rooms are structurally excluded from the buffer (A2)
  overbooking_buffer numeric(4,3) NOT NULL DEFAULT 0
                     CHECK (overbooking_buffer >= 0 AND overbooking_buffer <= 0.100),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text      NOT NULL UNIQUE,
  password_hash text      NOT NULL,
  role          user_role NOT NULL,
  venue_id      uuid REFERENCES venues(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A venue-scoped role without a venue would scope to nothing and read
  -- everything. A platform admin with a venue would look scoped and not be.
  -- Both are INV-6 failures, so the database refuses to store either.
  CONSTRAINT role_venue_agreement CHECK (
    (role IN ('VENUE_STAFF','VENUE_ADMIN') AND venue_id IS NOT NULL) OR
    (role IN ('CUSTOMER','PLATFORM_ADMIN') AND venue_id IS NULL)
  )
);
