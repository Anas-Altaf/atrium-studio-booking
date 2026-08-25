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
npm test                              # isolation, error mapping, append-only
```

**Stop the API replicas before `npm test`** — `docker compose stop api-1 api-2 api-3`.
Each replica runs a worker polling the same database once a second, and the
tests drive those jobs by hand. Left running, they claim the rows a test is
about to assert on. See Known Issues.

Invariants under chaos, against the running stack:

```
docker compose up -d --build          # paygate runs with PAYGATE_CHAOS=on
node bench/soak.mjs                   # INV-3, INV-4, INV-5 with nobody driving the jobs
```

Then ask the system to check its own books — INV-5, and the strongest single
piece of evidence here, because it is the invariant checking the other two:

```
curl -s localhost:8080/reports/reconciliation -H "authorization: Bearer $PLATFORM_TOKEN"
```

Benchmark, against the full profile:

```
npm run seed -- --profile=full        # 40 venues, 800 rooms, 250,000 bookings
npm run bench                         # k6 in compose, targets as thresholds
npm run explain                       # query plans, before and after 007
```

Results and machine spec in [LOAD_TEST.md](./LOAD_TEST.md).

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
| **CI** | GitHub Actions: Postgres service, migrate, seed demo, `npm test`. Named in the scoring rubric and at zero. |
| **Venue admin console, revenue report** | Tier 2. |
| **Redeploy** | The live instance predates the payment path — it serves M1's code. |

### Real defects

- **The test suite and the compose workers share a database.** `npm test` drives the worker jobs by hand; three replicas polling the same rows once a second claim them first, and the tests then fail in ways that look like logic errors. Stopping the replicas is the workaround. The fix is a database the tests own — not done.
- **Append-only took three migrations.** 006 revokes UPDATE/DELETE from `atrium_app`; the app connects as owner, and an owner can't be revoked from its own tables. 008 adds row triggers. `TRUNCATE` produces no row events and passed both, so 009 adds statement-level guards including the cascade path from `bookings`. All three kept. `tests/append-only.test.ts`.
- **Audit actor read from session variable.** Same mechanism rejected for RLS in §4A. Set with `SET LOCAL` so it can't outlive the transaction — a leak here puts wrong actor on audit row (data quality), not wrong data in the response (isolation).
- **DST pricing edge.** Bookings are priced on wall-clock hours. Affects a booking spanning a DST transition. Timestamps are `timestamptz` throughout.
- **Render free tier sleeps** after 15 min idle. First request after that has a 30-60s cold start. Background work stops while asleep.

### Known caveats

- **One-replica deployment.** The live API runs one process. The concurrency proof runs against three behind nginx locally. Both guarantees are enforced in the DB, not in application memory, so replica count affects throughput and lock-wait distribution — not correctness.
- **Frontend.** Demo surface over the API, not a product. Sign in, search rooms, hold a room, hold it again and see the 409. Shows correlation ids and venue counts as the cheapest INV-6 demonstration.