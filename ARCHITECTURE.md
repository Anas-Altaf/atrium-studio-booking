# ARCHITECTURE.md

> **Status: first draft, written before implementation.**
> This is the pre-code design commit required by section 02 ("Design before code").
> No hold endpoint exists in this repository at the time of this commit.
> Sections 1, 2, 5, 7 and 8 are stubs and will be filled as the build proceeds.
> If the final implementation contradicts anything below, the contradiction stays in
> the document with a note on what changed and why. Nothing here gets quietly rewritten.

---

## 0. Stack

Required by section 02 of the brief: the choice justified against at least one rejected
alternative. Placed first because §3 depends on it.

**PostgreSQL — chosen by the design, not by preference.** The concurrency model in §3 is built
on `EXCLUDE USING gist`, range types and generated columns.
*Rejected: MySQL* — no exclusion constraints, so room overlap would fall back to an
application-level check, which is the failure mode the brief names.

**TypeScript + Fastify.**
*Rejected: Python + FastAPI*, an equally good fit for this design. This is a familiarity
decision, not a technical one — under a 24-hour clock and a live defense held without notes,
the stack I write without thinking is the right stack. The cost is that Node's
single-threaded model is awkward for CPU-bound work, which is acceptable here because the
application layer is deliberately thin: the database does the work.

**No ORM and no query builder — plain `pg` with hand-written SQL.**
*Rejected: Prisma* — it cannot express `EXCLUDE USING gist`, generated columns, triggers,
`REVOKE`, or `SELECT ... FOR UPDATE`. All of them would become raw migration SQL,
`schema.prisma` would sit permanently drifted from the real schema, and there would be two
sources of truth. The ORM would be bypassed at exactly the points that matter.
*Kysely was also considered and rejected* — it solves the typing problem without hiding the
SQL, but its codegen is a tool I would be learning today, and in the live defense a repository
file holding the literal SQL Postgres will execute is easier to navigate than a builder API.
The accepted cost is no compile-time checking of column names; mitigated by parameterized
queries throughout, hand-written row interfaces, and an integration test per repository
method.

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

## 4A. Tenant isolation model (INV-6)

Numbered 4A so the section numbers the brief asks for keep their positions.

**Mechanism:** every repository method takes an `AuthScope` as its first parameter. There is
no overload without it, so a call that omits the scope does not compile. The scope carries the
caller's role, `user_id` and `venue_id`, and the repository derives the predicate from it —
`venue_id = $1` for venue-scoped roles, `user_id = $1` for `CUSTOMER`, unrestricted for
`PLATFORM_ADMIN`.

```ts
// does not compile
bookingRepo.findById(id)

// the only callable form
bookingRepo.findById(scope, id)
```

**Why it holds.** The failure this invariant is actually exposed to is not a clever attack, it
is a forgotten `WHERE` clause on an endpoint written late in the day. Making the scope a
required parameter moves that failure from review time to compile time, and the check cannot
be skipped because there is no code path that reaches SQL without passing through a repository
method.

Cross-venue reads return `404`, not `403` — see assumption A8. `403` confirms that a resource
exists, which discloses another tenant's data to someone probing by UUID.

**Rejected: Postgres row-level security.** It is the better fit for this design's general
preference for database-enforced guarantees, and it would survive a direct `psql` connection,
which this mechanism does not.

It was rejected because of connection pooling. RLS needs the current tenant set as a session
variable per request; a pooled connection returned to the pool with that variable still set
serves the next request under the previous tenant's scope. That is a **new** isolation failure
mode, created by the mechanism intended to prevent isolation failures, and it sits behind one
of the three scoring hard caps. `SET LOCAL` inside a transaction avoids it, but only if every
path remembers — which is the same forgetting problem, relocated.

Three further costs: `PLATFORM_ADMIN` needs a bypass, the reaper and webhook worker run
unscoped and need another, and `CUSTOMER` scopes by `user_id` rather than `venue_id`, so every
table needs two policies rather than one.

**Accepted cost.** This is a TypeScript guarantee, not a database one. A direct connection
bypasses it entirely. Accepted because the invariant is stated over endpoints — *"through any
endpoint, including by direct ID"* — and the required negative test exercises the API surface.
RLS remains the correct next step and is listed in §8.

---

## 4B. Refund policy model

The brief sets two requirements that pull against each other: policy is **data, not code** — a
venue admin changes tiers through the API and it takes effect immediately with no deployment —
and a policy change **must not retroactively alter the terms of an already CONFIRMED booking**.

**Mechanism: immutable policy versions.** `refund_policy_versions` is append-only. An admin
editing tiers does not update a row; it inserts a new version and the venue's pointer moves to
it. Every booking stores the `policy_version_id` in force when the booking was created, and
the refund calculator reads terms through that reference — never through the venue's current
version.

The platform default is itself a version in the same table, so a venue that has never set a
policy still has a pointer to a real row. There is no separate default branch.

```
v1  48h:100%  24h:50%  0h:0%     ← booking #812 points here, permanently
v2  48h:100%  24h:75%  0h:25%    ← venue's current version
```

**Why it holds.** The guarantee is not that the application declines to apply a new policy
retroactively — it is that the old rows still exist and the booking still points at them.
Nothing needs to remember to behave correctly.

**Rejected: mutable policy rows with the terms copied onto each booking at confirmation.**
Equally correct, and simpler to query since it needs no join. Rejected because it duplicates
the terms on every booking row, and because versioning gives policy history for free, which
matches how `audit_events` is already treated.

**Also rejected: distinguishing a "correction" from a "change".** The tempting version of this
lets an admin fix a typo in place while a genuine policy change creates a new version. It was
rejected because the system cannot verify that a claimed correction is one — `50% → 5%` is
indistinguishable from a typo fix and takes money from customers who already booked. It would
put the decision of whether a change is retroactive in the admin's hands, which turns the
guarantee into a setting. See A10 for how genuine mistakes are handled instead.

---

## 5. Indexing and query strategy

*TBD — EXPLAIN ANALYZE evidence before and after, against `--profile=full`.*

Initial intent: the GiST index backing the exclusion constraint doubles as the availability
index. Cross-venue search denormalizes `city` onto `rooms` to avoid a join in the hot path,
composite btree on `(city, capacity, hourly_rate)`, GIN on amenities, then a `NOT EXISTS`
anti-join against the range index over the reduced candidate set.

---

## 6. Assumptions

Ambiguities resolved independently. **The permitted batch of clarifying questions was
deliberately not sent** — every ambiguity below was resolvable on defensible grounds, and the
brief treats a documented assumption as earning credit where silence earns none. The cost of
that choice is that any divergence from the client's intent is absorbed here rather than
corrected early; A1 is the entry most exposed, since the two numbers it reconciles are
incompatible as written and admit more than one reasonable resolution. Reasoning recorded in
`TIMELINE.md`.

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
| A9 | The brief protects an "already CONFIRMED" booking from a policy change, but does not say which policy applies if the tiers change between hold and confirmation. | The `policy_version_id` is captured at **hold creation**, not at confirmation. The customer is shown terms at checkout and pays against them within minutes; binding at confirmation could apply terms they were never shown. This is stricter than the brief requires, and never weaker. |
| A10 | Policy versions are immutable, so a genuine admin mistake cannot be corrected for bookings already made under it. What happens then? | It is treated as an operations problem, not a schema one. The wrong version stays; the affected booking receives an explicit, audited adjustment recorded as its own money movement. Silently rewriting the policy would hide the correction from the reconciliation report, which INV-5 exists to make impossible. |

## 7. What breaks at 100x

*TBD.*

## 8. What I would do with two more weeks

*TBD.*
