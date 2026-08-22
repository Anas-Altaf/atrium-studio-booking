# ARCHITECTURE.md

> **Status: first draft, written before implementation.**
> This is the pre-code design commit required by section 02 ("Design before code").
> No hold endpoint exists in this repository at the time of this commit.
> Sections 1, 2, 5, 7 and 8 are stubs and will be filled as the build proceeds.
> If the final implementation contradicts anything below, the contradiction stays in
> the document with a note on what changed and why. Nothing here gets quietly rewritten.

---

## 1. Entity relationship diagram

*TBD — to be added once the schema is migrated.*

## 2. Booking state machine diagram

*TBD — transition matrix is already fixed (section 3.4 below); the diagram follows.*

---

## 3. Concurrency strategy

### 3.0 Position

Correctness for both inventory types is enforced **inside PostgreSQL**, not in application
code. Nothing in this design lives in process memory. There is no mutex, no semaphore, no
in-process map of held slots, and no distributed lock service. The single serialization
point is the database, which is the only component shared by all API replicas.

The stated failure mode in the brief — "query for conflicts, then insert" — is a
read-then-write race with a window between the check and the write. Every mechanism below
closes that window by making the check and the write the same operation.

### 3.1 Rooms — GiST exclusion constraint

**Mechanism:** a Postgres `EXCLUDE USING gist` constraint over `(room_id, reserved_range)`,
partial on the three blocking states.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT no_room_overlap
  EXCLUDE USING gist (
    room_id       WITH =,
    reserved_range WITH &&
  )
  WHERE (status IN ('HELD', 'PENDING_PAYMENT', 'CONFIRMED'));
```

`reserved_range` is a generated `tstzrange` of `[start_at, end_at + 15 minutes)`.

**Why the 15 minutes is inside the range.** The turnaround gap (section 04 operating rules)
is expressed as geometry rather than as a validation branch. Because range overlap is
mutual, extending only the tail is sufficient to enforce the gap on both sides: booking A
ending at 14:00 occupies until 14:15, and booking B starting at 14:10 occupies from 14:10,
so `&&` is true and the second insert is rejected. The buffer therefore cannot be bypassed
by any code path, including seed scripts and admin overrides.

**Why it holds.** The constraint is enforced by the index at write time under the row lock
Postgres takes for the insert. Two concurrent transactions attempting overlapping ranges on
the same room cannot both commit: the second blocks until the first resolves, then either
sees the committed row and raises `23P01` (`exclusion_violation`), or proceeds if the first
rolled back. There is no window between check and write because there is no separate check.
This is a database-level invariant, not a convention — it holds against any client,
including `psql`.

**Mapping to HTTP.** `23P01` is caught at the repository boundary and translated to a clean
`409 Conflict`. It must never surface as a 500. This is the only expected error path for a
lost race, and it is the assertion the 200-request proof depends on.

**Why not the alternatives.**

| Rejected | Reason |
|---|---|
| `SELECT ... WHERE overlaps` then `INSERT` | The named failure mode. Two transactions both read an empty conflict set before either writes. |
| `SERIALIZABLE` isolation + retry | Correct, but pays serialization-failure retries across *all* traffic to protect one table, and under 200 concurrent requests the retry storm is worse than a single index rejection. |
| Advisory lock on `hash(room_id)` | Correct across replicas, but coarser (hash collisions serialize unrelated rooms), and it protects only the paths that remember to take it. |
| Redis / Redlock | Adds a second source of truth that can disagree with Postgres, plus a fencing-token problem on lock expiry. Strictly worse when the database can do it natively. |
| Application mutex / semaphore | Fails on three replicas by construction. |

### 3.2 Equipment — row lock plus interval maximum-concurrency check

Exclusion constraints cannot express "at most N", so equipment needs a different mechanism.

**Mechanism:** inside the same transaction as the booking insert, take
`SELECT ... FROM equipment_types WHERE id = $1 FOR UPDATE`, then run the capacity check,
then insert the line items. The lock is held by Postgres for the transaction's duration and
is released on commit or rollback.

**Why it holds.** All contending transactions for a given `EquipmentType` serialize behind
that single row lock, so the capacity check is evaluated against a stable snapshot that no
concurrent writer can invalidate before commit. The lock is in the database, so it applies
identically regardless of which replica issued the query. Granularity is per equipment type,
so contention is confined to genuinely competing requests.

**The capacity check itself — the part that is easy to get wrong.**

The naive check sums the quantities of every booking overlapping the requested window and
compares that total against units owned. **This is incorrect.** Overlaps are partial, so a
sum over the window counts units that are never simultaneously out. A venue owning 6 cameras
with two 1-camera bookings at 09:00–10:00 and 10:00–11:00 would be charged 2 against a
request spanning 09:00–11:00, when true peak usage is 1.

The correct question is the **maximum concurrent reservation at any instant** inside the
requested interval. Usage is a step function that changes only at booking boundaries, so it
is sufficient to evaluate the candidate points:

- the requested `start_at`, plus
- the `start_at` of every overlapping booking that falls inside the requested window.

At each candidate point, sum the quantities of all bookings covering that instant. The
booking is admissible iff `max(point_sums) + requested_qty <= effective_capacity`.

```sql
WITH points AS (
  SELECT $2::timestamptz AS t
  UNION
  SELECT b.start_at
  FROM   booking_line_items li
  JOIN   bookings b ON b.id = li.booking_id
  WHERE  li.equipment_type_id = $1
    AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
    AND  b.start_at >= $2 AND b.start_at < $3
),
peak AS (
  SELECT p.t, COALESCE(SUM(li.quantity), 0) AS units
  FROM   points p
  LEFT JOIN bookings b
    ON b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
   AND b.start_at <= p.t AND b.end_at > p.t
  LEFT JOIN booking_line_items li
    ON li.booking_id = b.id AND li.equipment_type_id = $1
  GROUP BY p.t
)
SELECT MAX(units) FROM peak;
```

`effective_capacity = floor(units_owned * (1 + overbooking_buffer))`.

**Why not the alternatives.**

| Rejected | Reason |
|---|---|
| Materialize each physical unit as a row, reuse the room exclusion constraint | Correct by construction and genuinely attractive. Rejected because the 10% overbooking buffer would require creating and destroying phantom unit rows whenever an admin changes the buffer, and because it multiplies row count by unit count on the full profile. Revisit if the row lock becomes a bottleneck. |
| A `units_available` counter column with `UPDATE ... SET n = n - 1 WHERE n > 0` | This is the "stock column" the brief explicitly rules out. A counter has no time dimension and cannot represent 6 cameras out at 10:00 and 6 different cameras out at 14:00. |
| Sum of overlapping quantities | Incorrect as shown above. Fails safe (over-rejects) rather than overselling, so it would not violate INV-2 — but it rejects legitimate bookings, which is a correctness bug in the other direction. |

### 3.3 Behaviour across three replicas behind a load balancer

Neither mechanism has any process-local state, so replica count is irrelevant to correctness.
A request landing on replica 2 contends with a request on replica 3 through exactly the same
index entry and the same row lock it would contend with on a single instance. Adding replicas
changes throughput and lock-wait distribution; it does not change the set of admissible
outcomes.

The concurrency proof therefore runs against nginx fronting three API containers in
`docker compose`, not against a single process. A proof against one instance would not
distinguish this design from an in-memory mutex, which is precisely the distinction being
tested.

Expected result of the 200-request proof: exactly 1 room booking in a blocking state,
`SUM(quantity) <= 3` for the 3-unit equipment type at every instant, and every other request
returning `409`. Zero 5xx. Zero duplicate successes.

### 3.4 Expired holds and the reaper

A hold past its TTL but not yet reaped still satisfies the exclusion constraint's `WHERE`
clause, so it continues to block the slot. The predicate cannot reference `now()` — index
predicates must be `IMMUTABLE` — so expiry cannot be pushed into the constraint.

Accepted consequence: the system may **transiently under-sell** (a slot stays blocked for a
few seconds past expiry) but can never **oversell**. That is the correct direction to fail.
A background reaper transitions `HELD` rows past `expires_at` to `EXPIRED` on a short
interval (~15s), which removes them from the partial index and releases the slot. The reaper
is idempotent and safe to run concurrently on all three replicas, since each transition is
guarded by the state machine.

### 3.5 Transition enforcement

`UPDATE bookings SET status = ?` scattered across controllers is called out as a fail, so the
transition matrix is enforced by a `BEFORE UPDATE` trigger that validates
`(from_state, to_state)` and writes the corresponding `AuditEvent` in the same statement.
This makes "exactly one AuditEvent per transition" structurally true rather than
conventionally true, and makes it impossible to change state through a path that forgets to
audit. Illegal transitions raise, and are mapped to `409`.

`UPDATE` and `DELETE` are revoked on `audit_events` at the role level so append-only is a
database guarantee, not a code convention.

**Trade-off accepted:** meaningful business logic now lives in the database, which is harder
to unit test and harder for a reviewer to find than a service class. Recorded in
DECISIONS.md.

---

## 4. Payment integrity model

*Draft — full treatment follows the Paygate build.*

Exactly-once **effect** over an at-least-once, out-of-order channel. Deduplication is on
business effect, not on delivery identity: `X-Paygate-Delivery` is new on every attempt and
is therefore useless as a dedup key. The uniqueness constraint is on
`(charge_id, event_type)`.

- Idempotency key is derived deterministically from the payment attempt and persisted
  *before* the outbound call, so a 500 from `POST /charges` is retried with the same key.
- `UNIQUE (booking_id) WHERE status IN ('PENDING','CAPTURED')` — at most one live charge per
  booking, enforced by the database (INV-3).
- HMAC is verified against the **raw** request body before parsing. Invalid signature → 401,
  logged, never processed.
- Webhook for an unknown charge (the 25% race where the callback beats the 202) is persisted
  to `unmatched_webhooks` and returns 200, then resolved by a sweeper. Never 500, never
  dropped.
- Handler does: verify → dedup insert → enqueue → 200. No heavy work inline.
- INV-4: if the hold has expired when the capture webhook lands, the booking does **not**
  become CONFIRMED. It moves to a terminal cancelled/refunded state, an automatic refund is
  issued under the same idempotency discipline, and the full sequence is audited.
- INV-5: an append-only money ledger. Reconciliation is three anti-joins — captures with no
  CONFIRMED booking, CONFIRMED bookings with no capture, refunds with no matching capture.

## 5. Indexing and query strategy

*TBD — EXPLAIN ANALYZE evidence before and after, against `--profile=full`.*

Initial intent: the GiST index backing the exclusion constraint doubles as the availability
index. Cross-venue search denormalizes `city` onto `rooms` to avoid a join in the hot path,
composite btree on `(city, capacity, hourly_rate)`, GIN on amenities, then a `NOT EXISTS`
anti-join against the range index over the reduced candidate set.

---

## 6. Assumptions

Ambiguities resolved without waiting on a reply. Clarifying-questions email sent at
`[TIME]`; any answer that contradicts an entry below will be applied and the entry annotated
rather than deleted.

| # | Ambiguity | Resolution |
|---|---|---|
| A1 | Hold TTL is 8 minutes (section 04) but customers must get at least 10 minutes at checkout without losing the slot. These are incompatible as written. | Reaching checkout re-issues the hold with `expires_at = now() + 10 minutes`. The 8-minute TTL governs a hold that never reaches checkout. The slot is therefore never lost inside the guaranteed window. |
| A2 | INV-1 forbids room double-booking "under any circumstances", but a 10% overbooking buffer is permitted on "any inventory". | The buffer applies to **EquipmentType only**. For a single-unit room, 10% of 1 floors to 0 regardless, so the rules are reconciled rather than overridden. Rooms are structurally excluded from buffer logic. |
| A3 | Does the overbooking buffer apply to held inventory or only confirmed? | Applies to effective capacity in all blocking states, so held units count against the buffered ceiling. |
| A4 | Venues span Karachi, Dubai and London; London observes DST. | All timestamps stored as `timestamptz` in UTC. Every venue carries an IANA timezone. Operating-hours checks and the 48h / 24h / 2h refund boundaries are evaluated in **venue-local** time. |
| A5 | Must the 15-minute room turnaround fit inside published operating hours? | No. The gap is turnaround, not occupancy, and may extend past closing. |
| A6 | May a booking mix a room from one venue with equipment from another? | No. Line items must belong to the room's venue. Enforced as a check at hold creation. |
| A7 | Is partial equipment fulfilment acceptable? | No. A line item is all-or-nothing; insufficient units rejects the whole hold with a 409. |
| A8 | Cross-venue access: 403 or 404? | **404** on reads, to avoid disclosing the existence of another venue's resources by ID. 403 is reserved for in-venue privilege failures (e.g. VENUE_STAFF attempting a pricing change). |

## 7. What breaks at 100x

*TBD.*

## 8. What I would do with two more weeks

*TBD.*
