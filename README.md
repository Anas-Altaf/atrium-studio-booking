# Project Atrium

A studio booking platform. Rooms are booked as intervals and may never overlap; equipment is
booked as a quantity over an interval and may never exceed the units a venue owns at any
instant.

Both guarantees are enforced inside PostgreSQL, not in application code, so they hold across
three API replicas. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.

---

## Running it

Requires Docker and Node 20+.

```bash
docker compose up --build -d          # postgres + api-1/2/3 + nginx on :8080
docker compose logs -f api-1          # watch migrations apply

npm install
npm run seed -- --profile=demo        # 8 venues, 60 rooms, 25,000 bookings
npm run proof                         # the 200-request concurrency proof
npm test                              # cross-venue isolation, state machine
```

`docker compose up` stands up **three API replicas behind nginx**, not one. Round robin, no
sticky sessions — two requests for the same slot are expected to land on different processes.

Health check, which asks the database a question rather than reporting that the process is up:

```bash
curl localhost:8080/health
```

### Test logins

All use password `atrium123`.

| Email | Role | Venue |
|---|---|---|
| `customer@atrium.test` | CUSTOMER | — |
| `staff@atrium.test` | VENUE_STAFF | Venue A |
| `admin.a@atrium.test` | VENUE_ADMIN | Venue A |
| `admin.b@atrium.test` | VENUE_ADMIN | **Venue B** |
| `platform@atrium.test` | PLATFORM_ADMIN | all |

The second venue admin exists so cross-venue isolation can be tested from the deployed
instance rather than only in the test suite.

---

## The concurrency proof

```bash
npm run proof
```

Runs against the load balancer, never against a single replica — a proof against one process
would not distinguish this design from an in-memory mutex, which is the distinction being
tested. It asserts on the `x-served-by` header that all three replicas took traffic.

Two phases:

**Phase A** — 200 concurrent holds on the same room and the same one-hour slot. Asserts
exactly one success, 199 clean `409`, zero 5xx.

**Phase B** — 200 concurrent holds on 200 *different* rooms in the same slot, each requesting
one unit of an `EquipmentType` that owns exactly three. The rooms are distinct on purpose: if
every request named the same room, the room constraint would reject 199 of them before the
equipment check ever ran, and the phase would pass without testing anything. With distinct
rooms the only thing that can limit the run is the equipment check.

Output is pasted into `ARCHITECTURE.md` §3.3.

---

## Layout

```
db/migrations/     plain .sql, applied in filename order
src/repositories/  hand-written SQL; every method takes an AuthScope first
src/routes/        HTTP only, no SQL
tests/             the concurrency proof and the isolation negative test
ops/nginx.conf     the load balancer
```

Documents: [`ARCHITECTURE.md`](./ARCHITECTURE.md) is the main one.
[`DECISIONS.md`](./DECISIONS.md), [`AI_LOG.md`](./AI_LOG.md), [`TIMELINE.md`](./TIMELINE.md).

---

## Known Issues and What I Did Not Finish

Written bluntly, because a documented gap costs little and an undocumented one found in review
costs a great deal.

### Not built

| Area | State | How I would have built it |
|---|---|---|
| **Paygate and the whole payment path** | Not built. The design is complete in `ARCHITECTURE.md` §4 and the schema for it is migrated — `payments`, `refunds`, `webhook_events`, `unmatched_webhooks` all exist with their uniqueness constraints in place | Mock provider as a separate service with the chaos flags from the brief. Handler does verify HMAC on the raw body → insert on `(charge_id, event_type)` → return 200. A worker polls `webhook_events` with `FOR UPDATE SKIP LOCKED` and drives the state transition |
| **INV-3, INV-4, INV-5** | Enforced at the schema level (`one_live_charge_per_booking`, `one_live_refund_per_booking`) but not exercised, because nothing calls Paygate yet | §4, §4C |
| **Cancellation and refund calculation** | Not built. Policy versioning is migrated and every booking already carries its `policy_version_id`, so the terms are frozen correctly — nothing reads them yet | §4B, §4C |
| **The reaper** | Not built. `bookings_reaper_idx` exists for it. Consequence: expired holds keep blocking their slot indefinitely rather than for ~15 seconds | §3.4 |
| **Cross-venue search endpoint** | The query and its indexes are designed and migrated (§5); the route is not written |
| **`--profile=full` and `LOAD_TEST.md`** | Not run. The seed script supports both profiles from one code path, but no benchmark was taken, so there are no p50/p95/p99 numbers and no EXPLAIN evidence. §5 therefore carries a strategy without measurements |
| **Frontend** | Not built |
| **Everything in Tier 2 and Tier 3** | Not started. This was deliberate — see `TIMELINE.md` |

### Built but not verified

The database was not available in the environment where most of this was written, so
**migrations 001–008 and the application had not been executed at the time this section was
first written.** Anything that failed on first run is recorded in `AI_LOG.md` rather than
quietly fixed.

### Real defects

**Append-only had a hole.** Migration `006` revokes `UPDATE` and `DELETE` on `audit_events`
from `atrium_app`, which is the right mechanism — but an owner cannot be revoked from its own
tables, and the application connects as the owner both in `docker compose` and on a free
hosting tier where a second role is not always available. So the revoke was protecting
nothing. Migration `008` adds triggers that reject the mutation whichever role is connected.
Both are kept: the privilege is correct for production, the trigger is the one actually
fastened here.

**The audit trigger reads its actor from a session variable**, which is the same mechanism
rejected for row-level security in §4A. It is set with `SET LOCAL` so it cannot outlive the
transaction. The inconsistency is deliberate and argued in the migration comment: a leak here
puts a wrong actor on an audit row, a data-quality fault; the same leak under RLS would decide
what a caller is allowed to read.

**Bookings are priced on wall-clock hours**, so a booking spanning a DST transition in London
is charged for the hours the clock shows rather than the hours elapsed. Timestamps themselves
are `timestamptz` throughout and unaffected; this is a pricing edge, not a correctness one.

### Deployment note

On Render's free tier the service sleeps after 15 minutes idle, with a 30–60 second cold
start. The first request after a quiet period will be slow — that is the tier, not a fault.
Background work stops while the instance sleeps, which matters once the reaper exists.
