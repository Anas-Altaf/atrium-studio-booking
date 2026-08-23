# AI_LOG.md

What was delegated, where the agent was wrong or naive, what I overrode.

Verdicts: `ACCEPTED` / `MODIFIED` / `REJECTED`

---

### 1. Concurrency mechanisms — rooms and equipment
**Delegated:** Propose mechanisms holding across three replicas, given the brief rules out
check-then-insert and anything in process memory.

**Returned:** GiST exclusion constraint for rooms. For equipment, first answer was to sum the
quantities of all bookings overlapping the requested window.

**Verdict:** `MODIFIED` — rooms accepted, equipment rejected.

**What I overrode:** The sum is wrong. Overlaps are partial, so it counts units never
simultaneously out. Replaced with maximum concurrent reservation at candidate points inside
the window. Note the failure direction: the sum over-rejects rather than oversells, so INV-2
would have passed while legitimate bookings were quietly refused.

---

### 2. Turnaround gap and audit enforcement
**Delegated:** How to enforce the 15-minute room turnaround, and "exactly one AuditEvent per
transition".

**Returned:** Put the gap inside `reserved_range` as geometry; enforce transitions with a
`BEFORE UPDATE` trigger that writes the AuditEvent in the same statement.

**Verdict:** `ACCEPTED`

**Reasoning:** Both move the guarantee from convention to structure — no code path, including
seed scripts, can bypass either. Cost of the trigger (business logic in the database, harder
to test) is recorded rather than hidden.

---

### 3. Process rules extraction
**Delegated:** Consolidate the brief's non-code obligations into one file.

**Verdict:** `ACCEPTED` — used as a cross-check against my own reading, not a substitute.

---

### 4. Repository scaffolding
**Delegated:** CLAUDE.md and skeletons for the graded files.

**Returned:** Both instruction files — plus AI_LOG, DECISIONS and TIMELINE filled with the
agent's own prose, unasked, including system decisions before the architecture discussion had
happened.

**Verdict:** `MODIFIED`

**What I overrode:** Stripped the three graded files back to structure. Content in those files
is mine; there is a live defense with no notes, and prose I did not write is prose I cannot
defend. Added a working agreement to CLAUDE.md §11 — ask before writing, one file at a time,
structure not prose.

---

### 5. Agent asserted repository state without checking
**Delegated:** Create the required files.

**Returned:** Files created in a scratch directory rather than the repository. The agent also
stated the design draft still needed pushing and that the questions window was open — both
already settled.

**Verdict:** `REJECTED — corrected`

**Root cause:** reasoned forward from the brief's timeline instead of reading what was on
disk.

---

### 6. Plan for the remaining window
**Delegated:** With ~5.5 hours left and no code written, propose an order of work.

**Returned:** A schedule starting with schema and migrations, then auth, then the hold
endpoint, then deployment — driven by the three hard caps.

**Verdict:** `REJECTED`

**What I overrode:** The plan skipped architecture entirely. ARCHITECTURE.md §1, §2, §5, §7
and §8 are still stubs, and that document is 35% of the score — more than deployment and
observability combined. Writing schema before the ERD and the state machine are settled also
means migrating twice. Order corrected to: finish the architecture, then decide the stack
with that design in hand, then build.

**Also added:** a logging cadence to CLAUDE.md §11, so the graded files are updated after
every work block rather than at the end.

---

### 7. Stack proposal
**Delegated:** Propose a stack, given the design already fixed in ARCHITECTURE.md §3.

**Returned:** TypeScript + Fastify + Postgres, with Kysely as the query layer and plain SQL
migrations. Prisma ruled out because it cannot express exclusion constraints, generated
columns, triggers or `REVOKE`.

**Verdict:** `MODIFIED`

**What I changed:** The Prisma reasoning is right and I kept it. I dropped Kysely as well. It
needs codegen setup I have not used, and there is a live defense in which I have to navigate
and change this codebase from memory — a repository file holding the literal SQL is easier to
work with under that constraint than a builder API I would be learning today. Going with plain
`pg` and hand-written SQL, with parameterized queries, row interfaces and a test per
repository method as the mitigations.

**Worth recording separately:** settling the architecture first meant the stack was
constrained rather than chosen. Postgres is a consequence of INV-1, not a preference.

---

### 8. Tenant isolation mechanism
**Delegated:** Propose a mechanism for INV-6, noting the architecture said nothing about it
despite it being one of the three hard caps.

**Returned:** Three options — per-query `WHERE venue_id`, Postgres RLS, or a mandatory scope
parameter on every repository method — with the pooling hazard in RLS identified.

**Verdict:** `ACCEPTED`

**My reasoning for accepting:** The pooling argument decided it. RLS is the better fit for a
design that otherwise pushes guarantees into the database, but a session variable left set on
a returned connection serves the next request under the previous tenant's scope — a new
isolation bug introduced by the isolation mechanism, on a capped invariant. The scope
parameter moves the real failure (a forgotten `WHERE` on a late endpoint) to compile time
without adding a failure mode. Its cost — no protection against a direct `psql` connection —
is recorded rather than glossed over, and RLS is listed as the next step.

---

### 9. Refund policy — agent proposed complexity I cut
**Delegated:** How to satisfy "policy is data" and "no retroactive change to a CONFIRMED
booking" at the same time.

**Returned:** Versioned policy rows with the booking holding a version pointer — and then,
when I raised that an admin might need to fix a typo, a scheme where a version stays editable
until the first booking references it and freezes thereafter.

**Verdict:** `MODIFIED` — I took the versioning and cut the freezing rule.

**What I overrode:** The copy-on-write rule is defensible but it buys very little for the
machinery it adds: a second lifecycle for policy rows, a reference check on every edit, and a
harder sentence to say in the live defense. Versions are simply immutable — every edit creates
a new one. A mistake caught before any booking exists costs one unused row, which is not a
problem worth designing around.

**Where the agent was useful:** I had suggested letting an admin flag an edit as a
"correction" applied in place. It pushed back that the system cannot verify a claimed
correction — `50% → 5%` is indistinguishable from a typo fix while taking money from customers
who already booked — and that it would move the decision of whether a change is retroactive
into the admin's hands, making the guarantee a setting. That argument changed my mind, and the
operational-adjustment route it proposed instead became assumption A10.

---

### 10. Refund idempotency
**Delegated:** How to guarantee that double-clicking cancel refunds once.

**Returned:** Do not make the refund idempotent — make the cancellation idempotent, since the
refund is a consequence of it. The `CONFIRMED → CANCELLED` transition already serializes under
the state machine trigger's row lock, so no new mechanism is needed. Write the refund intent in
the same transaction and let a worker drive it with a derived `Idempotency-Key`.

**Verdict:** `ACCEPTED`

**My reasoning for accepting:** Reframing the problem from "one refund" to "one cancellation"
is what made it disappear — the guarantee was already built in §3.5 and I had been about to add
a second mechanism beside it. The gap it then identified is real: if the transition commits and
the Paygate call fails, the booking is cancelled with no money returned. Writing the intent in
the same transaction closes that.

**Where I pushed back:** it initially proposed `409` on a repeated cancel, following the
brief's wording on illegal transitions. I read that wording literally — an illegal transition
is a `(from, to)` pair absent from the matrix, and asking for a state the booking already holds
is not a transition but a replay. Settled as `200` with the existing refund, recorded as A11.

---

### 11. Background job mechanism
**Delegated:** Queue service or Postgres for the reaper, refund driver, webhook processing and
sweeper.

**Returned:** Postgres with `FOR UPDATE SKIP LOCKED`, on the grounds that an external queue
makes enqueueing a second write and a crash between commit and enqueue loses the job silently.

**Verdict:** `ACCEPTED`

**My reasoning for accepting:** The dual-write argument is the same one that decided §4C — a
guarantee that spans two systems is not a guarantee. Here it is sharper, because the thing lost
is money, and INV-5 is precisely about money not being lost silently. `SKIP LOCKED` also
answered the objection I had ready, that three replicas would collide on the same rows.

---

### 12. State machine, including failure edges
**Delegated:** Turn the brief's diagram into a full transition matrix with every failure edge.

**Returned:** The matrix, plus a table of refused transitions mapped to the Paygate chaos mode
that produces each one, and the observation that `EXPIRED → CONFIRMED` cannot simply be
refused — refusing it and stopping leaves captured money against a booking that will never
exist, so it must route to the refund path instead.

**Verdict:** `ACCEPTED`

**My reasoning for accepting:** The brief's diagram only shows the happy path plus three exits.
Tying each refused edge to the chaos mode that causes it is what makes the machine testable
rather than decorative, and the `EXPIRED → CONFIRMED` distinction is INV-4 stated as a
transition rather than as prose. Two edges are mine and are not in the brief's diagram:
`HELD → HELD` for the checkout re-issue in A1, and `HELD → CANCELLED` for a customer releasing
a hold before paying.

---

### 13. Schema and migrations
**Delegated:** Write the migrations from the agreed table shape, then §1 and §5.

**Verdict:** `MODIFIED`

**What the agent got right without being asked:** it caught that my proposed composite index
`(city, capacity, hourly_rate_minor)` wastes its third column — a btree stops seeking after the
first range predicate, and both `capacity >=` and `price <=` are ranges. Shipped as
`(city, capacity)` with price filtered on the reduced set, and the original left in §5 with a
note rather than rewritten.

**What I changed:** it wrote the audit trigger reading `actor_id` from a session variable —
the same mechanism I had just rejected for row-level security in §4A. I kept it, but only with
`SET LOCAL` and with the inconsistency addressed in a comment in the migration rather than left
for a reviewer to find: a variable leaking across a pooled connection puts a wrong actor on an
audit row, which is a data-quality fault, whereas in RLS the same leak decides what a caller
may read. Different blast radius, same mechanism.

**Not yet verified:** no Postgres was available in the environment where these were written, so
the migrations are unexecuted at the time of this entry. Anything that fails on first run gets
its own entry.

---

### 14. API core, compose stack, seed and concurrency proof
**Delegated:** Write the application: pool, migration runner, `AuthScope`, hold endpoint,
error translation, `docker compose` with three replicas behind nginx, the seed script, and the
concurrency proof.

**Verdict:** `MODIFIED` — four defects found on review, one of them serious.

**1. Fastify encapsulation (would not have run).** The agent registered the auth plugin and
the correlation plugin with `app.register()`. A decorator added inside a registered plugin
lives in that plugin's encapsulation context and is invisible to siblings, so
`app.authenticate` would not have existed where the routes are registered, and the correlation
hook would have applied to nothing. Both now wrapped with `fastify-plugin`. This is the kind
of error that reads as fine and fails at boot.

**2. Append-only was documented but not active.** Migration `006` revokes `UPDATE` and `DELETE`
on `audit_events` from `atrium_app` — correct in principle, and I accepted it when it was
written. Reviewing the compose file afterwards I noticed the application connects as the
*owner*, and an owner cannot be revoked from its own tables. The guarantee I had written into
`ARCHITECTURE.md` §3.5 as "a database guarantee, not a code convention" was protecting nothing
in the system as configured. Added migration `008`: triggers that reject the mutation whichever
role is connected. Both kept — the privilege is right for production, the trigger is the one
actually fastened here.

**3. Duplicate equipment lines.** Two line items naming the same equipment type would each be
capacity-checked against a peak not yet including the other, then collide on
`UNIQUE (booking_id, equipment_type_id)`. Now merged before any check runs.

**4. Request id.** The correlation id was assigned by mutating `req.id` in a hook rather than
through `genReqId`, so log lines would not have carried it. Moved.

**What the agent got right and I kept:** locking `equipment_types` in a fixed id order before
inserting the booking. I had not asked for it and had not thought about deadlock — two holds
naming the same two equipment types in opposite orders would deadlock without it.

**Where I corrected the proof it wrote.** Its first version fired all 200 requests at the same
room *and* the same equipment type. That passes while proving nothing about equipment: the
room exclusion constraint rejects 199 of them before the equipment check runs. Split into two
phases, with phase B using 200 distinct rooms so that the only thing able to limit the run is
the equipment check.

---

### 15. First real migration run — three defects, one of them mine
**Delegated:** Bring the stack up under `docker compose`, find out what actually fails, and
close whatever blocks Tier 1's hard caps in the remaining window.

**Verdict:** `MODIFIED`

**1. The generated column never compiled (mine, not the agent's).** `docker compose up` died on
`003` with `generation expression is not immutable`. `reserved_range` was written as
`tstzrange(start_at, end_at + interval '15 minutes')`, and a generated column's expression must
be IMMUTABLE — but `timestamptz + interval` is only STABLE, because the same operator also does
month and day arithmetic, which depends on the session TimeZone. `timestamp + interval`, without
the zone, is IMMUTABLE; that asymmetry is the whole bug. A fixed 15 minutes never touches
timezone rules, so wrapping it in a function marked IMMUTABLE is accurate rather than a
workaround. Verified before accepting it: same absolute instant under UTC, `Europe/London` across
a DST boundary, and `Asia/Karachi`. This is the design decision in CLAUDE.md §3 — the turnaround
as geometry — surviving contact with the database, and it stayed geometry.

**2. Cross-venue authorisation was missing on the write side.** `assertVenueWritable` existed,
was imported into the repository, was re-exported from it, and was called by nothing.
`createHold` loaded the room by id with no scope check at all, so a `VENUE_ADMIN` of venue A
could hold a room in venue B and receive a `201`. This sits directly under hard cap 3. The fix is
not `assertVenueWritable` as written: that helper returns false for a `CUSTOMER`, who has no
`venue_id` and must be able to book anywhere. The correct predicate is that only *venue-scoped*
roles are confined — `isVenueScoped(scope) && scope.venueId !== room.venue_id` — answered `404`
rather than `403` so the response cannot be used to enumerate room ids (A8).

**3. The test written for that cap could not have caught it.** `tenant-isolation.test.ts`
asserted only `400 <= status < 500` on the cross-venue hold. The room exclusion constraint
returns `409` whenever the seeded room happens to be busy, so the test would have gone green
against a completely unauthorised booking roughly half the time, depending on the seed. Tightened
to `403 | 404` plus an assertion that no booking row exists afterwards. Two fixtures were also
non-deterministic: venues were ordered by `created_at`, but the seed inserts them all in one
transaction so `now()` is identical on every row and the tie broke arbitrarily — the fixture could
hand venue A's booking to admin B and fail an otherwise correct system. Venues are now resolved
through the admin accounts themselves.

**Where I was wrong earlier.** Entry 13 records the migrations as unverified because no Postgres
was available. That was accurate, but I then let `008` and the isolation test be written and
reviewed on top of a schema that had never once been executed. The immutability failure was
sitting in `003` the whole time and would have been caught in ten seconds by a single run.

**Result:** 7/7 isolation tests pass against a seeded database. The cross-venue hold now returns
`404` and writes nothing.
