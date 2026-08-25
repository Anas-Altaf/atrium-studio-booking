# LOAD_TEST.md

**No load test was run. There are no p50/p95/p99 numbers in this file.**

## Targets

Local, `--profile=full`, p95:

| Endpoint | Target | Result |
|---|---|---|
| Room availability, 7-day range | < 300 ms | not run |
| Cross-venue search, combined filters | < 500 ms | not run |
| Create hold | < 250 ms | not run |
| Venue revenue report, 30 days | < 800 ms | endpoint not built |

## Script

**To be written.** Planned tool: `autocannon`. Script will fire holds and searches separately against nginx with the full-profile seed loaded.

## Machine spec

**To be recorded.** The benchmark will be run locally on the same machine used for development, with spec noted alongside the results.

## Why it was not run

`--profile=full` is 250,000 bookings, and every insert fires the audit trigger. The seed script supports it from the same code path, so this is a missing measurement, not a missing capability. Time went to deployment instead.

## How I would measure it

1. `npm run seed -- --profile=full`, then `ANALYZE`.
2. `autocannon` against nginx. Holds and searches separately — holds contend, searches do not.
3. `EXPLAIN (ANALYZE, BUFFERS)` on the search across a common amenity, a rare one, and none. Only the third case leaves `rooms_search_idx` as the sole candidate.
4. Record the machine spec with the numbers.

## What is known without it

Two query plans were read on the demo profile. They're in ARCHITECTURE.md — §5 for the search plan, §7.2 for the equipment peak check. Neither is a substitute for the benchmark: 64 rooms is two heap blocks, no index choice can lose at that size.

**Fixing this is priority #6 in ARCHITECTURE.md §8.**