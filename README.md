# Project Atrium

A studio booking platform. Rooms are intervals and may never overlap; equipment is a quantity over an interval and may never exceed what a venue owns at any instant.

---

## Setup

Requires Docker and Node 20+.

```
docker compose up --build -d          # postgres + api-1/2/3 + nginx on :8080
npm install
npm run seed -- --profile=demo        # 8 venues, 60 rooms, 25,000 bookings
npm run proof                         # 200-request concurrency proof
npm test                              # isolation + state machine tests
```

`docker compose up` stands up **three API replicas behind nginx** on `:8080`.

---

## Deployed

| | URL |
|---|---|
| API | https://atrium-api-c88i.onrender.com |
| Frontend | https://atrium-studio-booking.vercel.app |

### Test logins (password `atrium123`)

| Email | Role | Venue |
|---|---|---|
| `customer@atrium.test` | CUSTOMER | — |
| `staff@atrium.test` | VENUE_STAFF | Venue A |
| `admin.a@atrium.test` | VENUE_ADMIN | Venue A |
| `admin.b@atrium.test` | VENUE_ADMIN | **Venue B** |
| `platform@atrium.test` | PLATFORM_ADMIN | all |

---

## Known Issues and What I Did Not Finish

### Not built

| Area | How I would have built it |
|---|---|
| **Paygate + payment path** | Mock provider with chaos. Handler: verify HMAC → dedup on `(charge_id, event_type)` → 200. Worker polls `webhook_events` with `FOR UPDATE SKIP LOCKED`, drives state transitions. |
| **Cancellation + refund calculator** | Policy versions exist, every booking points at one — nothing reads them. Refund intent written in same transaction as cancel transition. Worker drives to Paygate. |
| **Reaper** | Guarded `UPDATE` on ~15s interval polling `bookings_reaper_idx`. |
| **Full-profile benchmark** | Targets + method in `LOAD_TEST.md`. Need `--profile=full` seed (250k bookings), `autocannon`, `EXPLAIN ANALYZE`. |

### Real defects

- **Append-only had a hole.** Migration 006 revoked at_role_level from `atrium_app`, but the app connects as owner — can't revoke itself. Migration 008 adds triggers that reject mutation from any role. Both kept.
- **`request-id` header overrides correlation id.** Fastify's default `requestIdHeader` takes precedence over `genReqId`. One option on the factory to fix. Logged.
- **`TRUNCATE` bypasses append-only triggers.** Row-level `BEFORE DELETE` doesn't fire on truncate. Needs `BEFORE TRUNCATE` trigger + separate migrator role for seed.
- **Audit actor read from session variable.** Same mechanism rejected for RLS in §4A. Set with `SET LOCAL` so it can't outlive the transaction — a leak here puts wrong actor on audit row (data quality), not wrong data in the response (isolation).
- **DST pricing edge.** Bookings are priced on wall-clock hours. Affects a booking spanning a DST transition. Timestamps are `timestamptz` throughout.
- **Render free tier sleeps** after 15 min idle. First request after that has a 30-60s cold start. Background work stops while asleep.

### Known caveats

- **One-replica deployment.** The live API runs one process. The concurrency proof runs against three behind nginx locally. Both guarantees are enforced in the DB, not in application memory, so replica count affects throughput and lock-wait distribution — not correctness.
- **Frontend.** Demo surface over the API, not a product. Sign in, search rooms, hold a room, hold it again and see the 409. Shows correlation ids and venue counts as the cheapest INV-6 demonstration.