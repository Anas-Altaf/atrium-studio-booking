# LOAD_TEST.md

Local benchmark, `--profile=full`, against three API replicas behind nginx.

## How to reproduce

```
docker compose up -d --build        # db + api-1/2/3 + lb on :8080
npm run seed -- --profile=full      # 40 venues, 800 rooms, 2,500 units, 250,000 bookings
npm run bench                       # docker compose --profile bench run --rm k6
npm run explain                     # EXPLAIN ANALYZE, before and after the 007 indexes
```

k6 runs as a compose service on the same network as the load balancer, so there
is nothing to install beyond Docker, which this repo already requires. The
brief's four targets are k6 thresholds, not a table to eyeball: a miss exits
non-zero.

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

Two things about that hold row. The 409s are the seeded calendar and the
previous run's own bookings holding the slot — correct behaviour, so they are
not counted as errors. And the p95 is measured over holds that were **placed**:
a rejected hold leaves before most of the work happens, so averaging the two
together produces a number that improves as the system does less.

Availability is the one with headroom to spare rather than to burn — p99 is
353 ms against a 300 ms p95 target. The EXPLAIN below says why.

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

Postgres is on default memory settings. That matters for reading the plans
below: 128 MB of shared buffers is holding a 250,000 row table plus its indexes.

## EXPLAIN: before and after the indexing work

"Before" means before migration 007. It does **not** mean before the GiST
exclusion index on `bookings` — that index backs the `no_room_overlap`
constraint from 003, which is INV-1 itself. Removing it to produce a slower plan
would be measuring a system that double-books.

Both plans are run warm. The first attempt at this reported the indexed query as
*slower* than the unindexed one, purely because it ran first and paid for the
disk reads; `bench/explain.sql` now runs each query once with output discarded
before measuring it.

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

Almost nothing, and that is the finding. 18.88 ms to 18.76 ms. The index does
what it was built to do — a seq scan of 800 rooms becomes a bitmap index scan
reading 2 buffers — but 800 rooms is 18 heap pages, so the scan it replaced was
already free.

**17 of those 18 ms are the availability anti-join**, and both plans pay it
identically. `no_room_overlap` is keyed `(room_id, reserved_range)`, but with a
7 day window and no room to anchor on, the planner reads every active booking in
that window across all 40 venues — 2,137 rows, 433 buffers — and only then
hash-joins the result against the 55 rooms that survived the city filter. The
city filter never reaches the index.

Also worth noting: the planner estimates 417 rows and gets 2,137. GiST
selectivity estimation on `&&` over `tstzrange` is a 5x under-estimate here,
which is what pushed it to a hash anti-join rather than a per-room probe.

### What I would do next

1. Force the room set to lead. Materialise the candidate rooms in a CTE and
   probe `no_room_overlap` per room. 55 index probes against a 2,137 row scan.
2. Give the index a tenant dimension — GiST on `(venue_id, reserved_range)`, or
   `city` denormalised onto `bookings` the way it already is onto `rooms`. Then
   a city-filtered search stops reading other cities' bookings.
3. Only then revisit `rooms_search_idx`. It is not paying for itself at 800
   rooms, but it is not costing anything either, and it is the right index at
   the room count where the anti-join has been fixed.

None of this is needed to hit the targets today. It is what breaks first when
the window widens or the venue count grows, and it belongs with the 100x
analysis in ARCHITECTURE.md §7 rather than in a tuning pass now.

## Files

| | |
|---|---|
| `bench/k6/load-test.js` | the script — scenarios, thresholds, summary table |
| `bench/explain.sql` | both plans, in a transaction that rolls back |
| `bench/k6/summary.json` | k6's full metric dump from the run above |
