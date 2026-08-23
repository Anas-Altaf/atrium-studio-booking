# LOAD_TEST.md

## Status

**No load test was run, and there are no p50/p95/p99 numbers in this file.** The window closed
with the payment path unbuilt and the deployment unfinished, and both outranked benchmarking.

What follows is what *was* measured, on the demo profile, and what those measurements do and do
not tell us. No number here is estimated or extrapolated unless it says so.

## Targets

Local, `--profile=full`, p95:

| Endpoint | Target | Measured |
|---|---|---|
| Room availability, 7-day range | < 300 ms | not run |
| Cross-venue search, combined filters | < 500 ms | not run |
| Create hold | < 250 ms | not run |
| Venue revenue report, 30 days | < 800 ms | endpoint not built |

## Why `--profile=full` was not run

The seed script supports it from the same code path — `npm run seed -- --profile=full` — so this
is not a missing capability. It is 250,000 bookings against 800 rooms, and every booking insert
fires the audit trigger, so the run is long enough that starting it meant not finishing something
else. It was not started.

That leaves §5 carrying an indexing strategy with no measurements behind it, which is the single
largest evidence gap in the submission.

## What was measured

Demo profile: 64 seeded rooms, 24,687 bookings, `shared_buffers` 128 MB, Postgres 16 in
`docker compose`.

### Cross-venue search — 2.6 ms, but the wrong index

`EXPLAIN (ANALYZE, BUFFERS)` on the §5 query with city, capacity, price, amenity and an
availability window:

```
Limit (actual time=2.605..2.609 rows=11 loops=1)
  ->  Hash Anti Join (actual time=2.401..2.427 rows=11 loops=1)
        ->  Bitmap Heap Scan on rooms r (actual time=0.416..0.439 rows=11)
              Recheck Cond: (amenities @> '{wifi}'::text[])
              Filter: ((capacity >= 10) AND (hourly_rate_minor <= 1200000) AND (city = 'Karachi'))
              Rows Removed by Filter: 13
              ->  Bitmap Index Scan on rooms_amenities_idx (rows=24)
        ->  Hash
              ->  Index Only Scan using no_room_overlap on bookings b (actual time=1.096..1.922)
                    Index Cond: (reserved_range && '[...]'::tstzrange)
                    Heap Fetches: 1
```

Two things in that plan matter more than the 2.6 ms.

**The availability probe behaved as §5 predicted.** It is an `Index Only Scan` on the partial
GiST index, with one heap fetch. The anti-join is the cheap half.

**`rooms_search_idx` was not used, and never has been.** `pg_stat_user_indexes` reports
`idx_scan = 0` for it. The planner drove the query from the amenities GIN and pushed city,
capacity and price down to a heap filter that discarded 13 of 24 candidate rows.

### Equipment peak check — 12,740 rows discarded per hold

```
->  Nested Loop Left Join
      Join Filter: ((b.start_at <= now()) AND (b.end_at > now()))
      Rows Removed by Join Filter: 12740
```

On a 24,687-row table, one hold examines and throws away 12,740 rows, inside the transaction
that holds `FOR UPDATE` on the equipment type. This is analysed in ARCHITECTURE §7.2 and is the
first thing I would fix, benchmark or not.

## The §5 open question, partially answered

§5 asked whether filtering price on the reduced set is sufficient, or whether the planner needs
steering toward a `BitmapAnd` of `rooms_search_idx` with the amenities GIN.

At demo scale the planner chose neither: no `BitmapAnd`, and the composite index unused. That is
**not** evidence that `rooms_search_idx` is wrong. With 64 rooms and 24 of them carrying `wifi`,
the GIN is selective enough on its own and the whole table is two heap blocks — at that size no
index choice can lose. Demo scale cannot answer the question, and reading it as an answer would
be the mistake.

The question is genuinely open, and it is open in a sharper form now: at 800 rooms, does the
`(city, capacity)` seek beat the GIN bitmap, or does the planner keep choosing the GIN and pay a
growing heap filter? A `BitmapAnd` only appears if neither index is selective enough alone.

## How I would measure it

1. `npm run seed -- --profile=full`, then `ANALYZE`.
2. `EXPLAIN (ANALYZE, BUFFERS)` the search query across three selectivity shapes: a common
   amenity, a rare one, and none — the GIN's advantage should move with that, and the third case
   is the only one where `rooms_search_idx` is the only candidate.
3. Read `idx_scan` on `rooms_search_idx` after a batch of varied searches. Still zero at 800
   rooms means it should be dropped rather than defended: an unused index is write cost for
   nothing.
4. Only then decide about steering. Forcing a plan with `enable_*` settings proves what the plan
   would cost, not what the planner will do; the honest fix is usually statistics targets or a
   different index, not a hint.
5. Load itself: `autocannon` against nginx for the p50/p95/p99 table, holds and searches
   separately, since holds contend and searches do not. Machine spec recorded with the numbers.

## What I expect to fail first

Not the search. The equipment peak check, on the evidence above — it is the only query measured
here whose cost grows with the size of `bookings` rather than with the size of `rooms`, and it
runs while holding a row lock. ARCHITECTURE §7 has the remedy.
