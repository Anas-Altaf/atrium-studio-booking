# LOAD_TEST.md

Local benchmark, `--profile=full`, against three API replicas behind nginx.

## How to reproduce

```
docker compose up -d --build        # db + api-1/2/3 + lb on :8080
npm run seed -- --profile=full      # 40 venues, 800 rooms, 2,500 units, 250,000 bookings
npm run bench                       # docker compose --profile bench run --rm k6
npm run explain                     # EXPLAIN ANALYZE, before and after the 007 indexes
```

k6 runs as a compose service on the same network as the load balancer. Nothing
to install beyond Docker. The brief's targets are declared as k6 thresholds, so
a missed target exits non-zero.

Seed first, then benchmark. The hold phase writes real bookings, so a second run
over the same data meets its own rows. `HOLD_OFFSET=4000` moves it to a fresh
part of the slot pool if a reseed is not wanted.

## Results

20 connections per phase, phases run one after another. Latency in ms.

| Endpoint | Target p95 | p50 | p95 | p99 | max | Error rate | Met |
|---|---|---|---|---|---|---|---|
| Availability window, 7 day range | < 300 ms | 90.4 | **230.1** | 353.3 | 482.7 | 0.00% | yes |
| Cross-venue search, combined filters | < 500 ms | 24.8 | **55.6** | 83.2 | 622.0 | 0.00% | yes |
| Create hold | < 250 ms | 75.5 | **172.2** | 218.1 | 308.4 | 0.00% | yes |
| Venue revenue report, 30 days | < 800 ms | — | — | — | — | — | endpoint not built |

Holds attempted 4,000 · placed 2,679 · 409 conflicts 1,321 · anything else 0.

How the hold row is measured:

- 409s are the seeded calendar and the previous run's own bookings holding the slot. `http.setResponseCallback` treats 200-299 and 409 as expected, so they are not counted in the error rate.
- The p95 is over holds that were **placed** (`hold_created_duration`), not over all hold requests. A rejected hold returns before most of the work happens.
- Availability p99 is 353.3 ms; the target is on p95.

### Not measured

- **Venue revenue report** — Tier 2, not built. No endpoint to point k6 at.
- **A dedicated per-room availability endpoint** — not built. The row above is
  the cross-venue search carrying a 7 day `from`/`to` window, which runs the
  same anti-join over the same index.

## Machine spec

| | |
|---|---|
| CPU | AMD Ryzen 7 4700U, 8 logical cores |
| Memory | 15.2 GiB host, 7.9 GiB allocated to the Docker VM |
| OS | Windows 11 (10.0.26200), Docker 29.1.2 |
| Postgres | 16.15 in Docker, `shared_buffers` 128 MB, `work_mem` 4 MB — stock |
| Node | v22.17.1 |
| Load balancer | nginx:alpine, three API replicas |

Postgres is on default memory settings: 128 MB of shared buffers holding a
250,000 row table plus its indexes.

## EXPLAIN: before and after the indexing work

"Before" means before migration 007. It does not mean before the GiST exclusion
index on `bookings` — that index backs the `no_room_overlap` constraint from
003, which is INV-1 itself, so it is present in both plans.

Both plans are run warm. The first attempt reported the indexed query as slower
than the unindexed one because it ran first and paid for the disk reads;
`bench/explain.sql` now runs each query once with output discarded before
measuring.

### After — with `rooms_search_idx` and `rooms_amenities_idx`

```
 Limit  (cost=69.83..69.91 rows=32 width=130) (actual time=18.292..18.301 rows=4 loops=1)
   Buffers: shared hit=453
   ->  Sort  (actual time=18.287..18.294 rows=4 loops=1)
         Sort Key: r.hourly_rate_minor, r.id
         ->  Hash Right Anti Join  (cost=34.22..69.03 rows=32) (actual time=18.230..18.248 rows=4 loops=1)
               Hash Cond: (b.room_id = r.id)
               Buffers: shared hit=453
               ->  Index Only Scan using no_room_overlap on bookings b
                     (cost=0.29..31.59 rows=417) (actual time=0.454..16.337 rows=2137 loops=1)
                     Index Cond: (b.reserved_range && tstzrange(now+10d, now+17d, '[)'))
                     Heap Fetches: 0
                     Buffers: shared hit=433
               ->  Hash  (actual time=0.403..0.406 rows=55 loops=1)
                     ->  Bitmap Heap Scan on rooms r  (actual time=0.115..0.321 rows=55 loops=1)
                           Recheck Cond: ((city = 'Karachi') AND (capacity >= 10))
                           Filter: ((hourly_rate_minor <= 1200000) AND (amenities @> '{wifi}'))
                           Rows Removed by Filter: 176
                           Buffers: shared hit=20
                           ->  Bitmap Index Scan on rooms_search_idx
                                 (actual time=0.076..0.077 rows=231 loops=1)
                                 Buffers: shared hit=2
 Planning Time: 1.571 ms
 Execution Time: 18.756 ms
```

### Before — same query, those two indexes dropped

```
 Limit  (cost=70.73..70.81 rows=32 width=130) (actual time=18.583..18.590 rows=4 loops=1)
   Buffers: shared hit=451
   ->  Sort  (actual time=18.579..18.584 rows=4 loops=1)
         ->  Hash Right Anti Join  (cost=35.12..69.93 rows=32) (actual time=18.522..18.538 rows=4 loops=1)
               Hash Cond: (b.room_id = r.id)
               Buffers: shared hit=451
               ->  Index Only Scan using no_room_overlap on bookings b
                     (cost=0.29..31.59 rows=417) (actual time=0.350..17.074 rows=2137 loops=1)
                     Index Cond: (b.reserved_range && tstzrange(now+10d, now+17d, '[)'))
                     Heap Fetches: 0
                     Buffers: shared hit=433
               ->  Hash  (actual time=0.748..0.750 rows=55 loops=1)
                     ->  Seq Scan on rooms r  (actual time=0.040..0.666 rows=55 loops=1)
                           Filter: (capacity >= 10 AND hourly_rate_minor <= 1200000
                                    AND amenities @> '{wifi}' AND city = 'Karachi')
                           Rows Removed by Filter: 745
                           Buffers: shared hit=18
 Planning Time: 1.008 ms
 Execution Time: 18.878 ms
```

### What changed

Execution time 18.88 ms → 18.76 ms.

| | Before | After |
|---|---|---|
| Room access | Seq Scan, 800 rows scanned, 745 filtered, 18 buffers | Bitmap Index Scan on `rooms_search_idx`, 231 rows, 2 buffers, then heap 18 buffers |
| Availability anti-join | Index Only Scan on `no_room_overlap`, 2,137 rows, 433 buffers, 17.07 ms | same index, 2,137 rows, 433 buffers, 16.34 ms |
| Join | Hash Right Anti Join | Hash Right Anti Join |

The room access changed and the cost did not: both plans spend 17 of 18 ms in
the availability anti-join, which reads every active booking in the window across
all 40 venues before the city filter applies.

Planner estimate for that scan is 417 rows, actual 2,137 — a 5x under-estimate
on GiST `&&` selectivity over `tstzrange`.

### Options not applied

- Materialise candidate rooms in a CTE so the room set leads: 55 index probes instead of a 2,137 row scan.
- Tenant dimension on the GiST index — `(venue_id, reserved_range)`, or `city` denormalised onto `bookings`.

All three targets are met without them. Related: ARCHITECTURE.md §7.

## Files

| | |
|---|---|
| `bench/k6/load-test.js` | the script — scenarios, thresholds, summary table |
| `bench/explain.sql` | both plans, in a transaction that rolls back |
| `bench/k6/summary.json` | k6's full metric dump from the run above |
