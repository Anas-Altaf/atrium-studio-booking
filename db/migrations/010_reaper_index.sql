-- 010  The reaper index has to cover PENDING_PAYMENT, not just HELD.
--
-- INV-4 is about a hold that expires while payment is in flight. That booking
-- is in PENDING_PAYMENT, and 007 indexed only HELD, so the one state the
-- invariant is about was the one the reaper could not find.
--
-- The transition matrix already permits PENDING_PAYMENT -> EXPIRED (005). Only
-- the index was missing.

DROP INDEX bookings_reaper_idx;

CREATE INDEX bookings_reaper_idx
  ON bookings (expires_at)
  WHERE status IN ('HELD', 'PENDING_PAYMENT');
