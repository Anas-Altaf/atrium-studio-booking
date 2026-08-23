-- 007  Indexes beyond those created implicitly by constraints.
--
-- Already present from earlier migrations:
--   bookings   GiST (room_id, reserved_range) partial  -- exclusion constraint,
--              doubles as the availability index
--   payments   unique partial on booking_id, unique on charge_id
--   refunds    unique partial on booking_id

-- Reaper: find expired holds. Partial, so it stays small however large the
-- table grows, because HELD is a transient state.
CREATE INDEX bookings_reaper_idx
  ON bookings (expires_at) WHERE status = 'HELD';

-- Venue reports over a date range.
CREATE INDEX bookings_venue_time_idx ON bookings (venue_id, start_at);

-- A customer listing their own bookings.
CREATE INDEX bookings_user_time_idx ON bookings (user_id, start_at DESC);

-- Equipment peak check: find line items of one type on overlapping bookings.
CREATE INDEX line_items_equipment_idx
  ON booking_line_items (equipment_type_id, booking_id);

-- Cross-venue search. city is an equality filter and the most selective, so it
-- leads. capacity follows.
--
-- Deliberately NOT (city, capacity, hourly_rate_minor): capacity is a range
-- predicate (>=) and price is another (<=), and a btree stops using columns
-- after the first range. The third column would sit in the index unused while
-- making it larger. Price is left to a filter on the reduced set, and EXPLAIN
-- against --profile=full decides whether that is enough. Recorded in
-- ARCHITECTURE.md 5.
CREATE INDEX rooms_search_idx ON rooms (city, capacity);

CREATE INDEX rooms_amenities_idx ON rooms USING gin (amenities);

-- Worker polling, driven by FOR UPDATE SKIP LOCKED (4D).
CREATE INDEX refunds_due_idx
  ON refunds (next_attempt_at) WHERE status = 'PENDING';

CREATE INDEX webhook_events_due_idx
  ON webhook_events (next_attempt_at) WHERE processed_at IS NULL;

CREATE INDEX unmatched_webhooks_open_idx
  ON unmatched_webhooks (charge_id) WHERE resolved_at IS NULL;
