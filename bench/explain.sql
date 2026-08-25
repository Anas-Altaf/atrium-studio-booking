-- EXPLAIN evidence for the availability and search path, before and after the
-- indexing work in migration 007. Run against --profile=full:
--
--   docker compose exec -T db psql -U atrium -d atrium -f - < bench/explain.sql
--
-- "Before" means before 007. It does not mean before the GiST exclusion index
-- on bookings: that index backs the no_room_overlap constraint from 003, which
-- is INV-1 itself. Dropping it to produce a slower plan would be measuring a
-- system that double-books, so the availability half of these plans reads the
-- same index in both runs. What 007 added, and what these two plans differ by,
-- is how the room set is narrowed before the availability test runs at all.

-- Each plan is run once with its output discarded before being measured. The
-- first attempt at this reported the indexed query as slower than the
-- unindexed one, entirely because it ran first and paid for the reads.

\timing on
\pset pager off

SELECT '=== AFTER: with 007 indexes ===' AS section;

\o /dev/null
SELECT r.id FROM rooms r
WHERE  r.city = 'Karachi' AND r.capacity >= 10
  AND  r.hourly_rate_minor <= 1200000 AND r.amenities @> ARRAY['wifi']::text[]
  AND  NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE  b.room_id = r.id
           AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
           AND  b.reserved_range && tstzrange(
                  date_trunc('day', now()) + interval '10 days',
                  date_trunc('day', now()) + interval '17 days', '[)')
       )
ORDER BY r.hourly_rate_minor, r.id LIMIT 50;
\o

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT r.id, r.venue_id, r.name, r.city, r.capacity,
       r.hourly_rate_minor, r.amenities
FROM   rooms r
WHERE  r.city = 'Karachi'
  AND  r.capacity >= 10
  AND  r.hourly_rate_minor <= 1200000
  AND  r.amenities @> ARRAY['wifi']::text[]
  AND  NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE  b.room_id = r.id
           AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
           AND  b.reserved_range && tstzrange(
                  date_trunc('day', now()) + interval '10 days',
                  date_trunc('day', now()) + interval '17 days', '[)')
       )
ORDER  BY r.hourly_rate_minor, r.id
LIMIT  50;

-- The same query with only the search indexes removed. Inside a transaction
-- that rolls back, so the database is unchanged afterwards.
BEGIN;

DROP INDEX rooms_search_idx;
DROP INDEX rooms_amenities_idx;

SELECT '=== BEFORE: without rooms_search_idx and rooms_amenities_idx ===' AS section;

\o /dev/null
SELECT r.id FROM rooms r
WHERE  r.city = 'Karachi' AND r.capacity >= 10
  AND  r.hourly_rate_minor <= 1200000 AND r.amenities @> ARRAY['wifi']::text[]
  AND  NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE  b.room_id = r.id
           AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
           AND  b.reserved_range && tstzrange(
                  date_trunc('day', now()) + interval '10 days',
                  date_trunc('day', now()) + interval '17 days', '[)')
       )
ORDER BY r.hourly_rate_minor, r.id LIMIT 50;
\o

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT r.id, r.venue_id, r.name, r.city, r.capacity,
       r.hourly_rate_minor, r.amenities
FROM   rooms r
WHERE  r.city = 'Karachi'
  AND  r.capacity >= 10
  AND  r.hourly_rate_minor <= 1200000
  AND  r.amenities @> ARRAY['wifi']::text[]
  AND  NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE  b.room_id = r.id
           AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
           AND  b.reserved_range && tstzrange(
                  date_trunc('day', now()) + interval '10 days',
                  date_trunc('day', now()) + interval '17 days', '[)')
       )
ORDER  BY r.hourly_rate_minor, r.id
LIMIT  50;

ROLLBACK;

SELECT '=== row counts this ran against ===' AS section;
SELECT 'bookings' AS table, count(*) FROM bookings
UNION ALL SELECT 'rooms', count(*) FROM rooms
UNION ALL SELECT 'venues', count(*) FROM venues;
