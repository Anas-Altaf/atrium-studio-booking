-- 011  What a venue console needs: archiving, and the revenue report's index.

-- Rooms, equipment and users are referenced by bookings and audit_events, both
-- of which must survive. Removing a room would either orphan its history or
-- cascade it away, so retiring inventory sets a flag: existing bookings stand,
-- new ones cannot be made against it (A15).
ALTER TABLE rooms           ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE equipment_types ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users           ADD COLUMN active boolean NOT NULL DEFAULT true;

-- The search index becomes partial on the same flag, so excluding archived
-- rooms costs nothing and shrinks the index instead of growing a filter.
DROP INDEX rooms_search_idx;
CREATE INDEX rooms_search_idx ON rooms (city, capacity) WHERE active;

-- Revenue and utilisation, 30 days, one venue. bookings_venue_time_idx covers
-- the same columns for every status; a report reads two of eight, so the
-- partial index is a fraction of the size and stays in cache.
CREATE INDEX bookings_revenue_idx
  ON bookings (venue_id, start_at)
  WHERE status IN ('CONFIRMED', 'COMPLETED');

-- Listing a venue's staff, and the console's room and equipment tables.
CREATE INDEX users_venue_idx           ON users (venue_id) WHERE venue_id IS NOT NULL;
CREATE INDEX rooms_venue_idx           ON rooms (venue_id);
CREATE INDEX equipment_types_venue_idx ON equipment_types (venue_id);
