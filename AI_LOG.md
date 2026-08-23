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

### 15. First migration run
**Delegated:** Bring the stack up under `docker compose` and fix whatever blocks the hard caps.

**Verdict:** `MODIFIED` — three defects, the first one mine.

**The schema had never been able to migrate.** `003` died on
`generation expression is not immutable`. A generated column's expression must be IMMUTABLE and
`timestamptz + interval` is only STABLE, because the same operator also does month and day
arithmetic that depends on TimeZone. `timestamp + interval` is IMMUTABLE; that asymmetry is the
bug. A fixed 15 minutes never touches timezone rules, so an IMMUTABLE wrapper is accurate rather
than a workaround — checked under UTC, `Europe/London` across a DST boundary, and
`Asia/Karachi` before accepting it. Every later migration then applied unchanged.

**`createHold` had no venue check.** `assertVenueWritable` was imported into the repository,
re-exported from it, and called by nothing, so a `VENUE_ADMIN` could hold another venue's room
and get a `201`. That is hard cap 3. The helper is also the wrong test: it returns false for a
`CUSTOMER`, who has no venue and must be able to book anywhere. The predicate is that only
venue-scoped roles are confined. Answered `404`, not `403`, so it cannot be used to enumerate
room ids (A8).

**The test for that cap could not have caught it.** It asserted `400 <= status < 500`, and the
exclusion constraint returns `409` whenever the seeded room is busy — so it would have passed
against an unauthorised booking about half the time. Now `403 | 404` plus an assertion that no
row was written. Two fixtures were also ordered by a `created_at` that is identical on every
seeded venue, since the seed inserts them in one transaction.

**Where I was wrong:** entry 13 recorded the migrations as unverified, and I then let `008` and
the isolation test be built on top of a schema that had never once run. One execution would have
found the immutability failure immediately.

---

### 16. First 200-request proof run
**Delegated:** Three replicas behind nginx, then run the proof.

**Verdict:** `MODIFIED` — three defects.

**The stack never started.** `api-1`'s healthcheck used `http://localhost:3000/health`. Inside
the container `localhost` resolves to `::1`, the server binds `0.0.0.0`, and the check was
refused — so `api-1` stayed unhealthy and the other two replicas and nginx never started, while
the logs said "listening". Changed to `127.0.0.1`.

**Deadlocks answered `500`.** First run: 195 × 500, zero successes. A GiST exclusion constraint
at 200-way concurrency genuinely deadlocks — two inserts place their index entries, then each
scans, finds the other, and waits on it, so Postgres kills one with `40P01`. The invariant was
never at risk; the response code was. A deadlock is a lost race, and the brief requires a lost
race to be a clean `409`. Retried in `withTransaction` — the victim is fully rolled back, so
replay is safe — and translated if it survives. The pool was also too small at 10: every waiter
holds a connection for the length of its wait.

**The fixture could not clean up after itself.** It deleted the previous run's rows, which
`audit_events` refuses — it holds a foreign key to every booking and `008` blocks the delete
whichever role is connected. That is the guarantee working, so the fixture is per-run now and
deletes nothing.

---

### 17. Deployment preparation
**Delegated:** Prepare Neon, Render and Vercel — CORS, TLS, a service definition, a frontend.

**Verdict:** `MODIFIED` — the buildable parts are done; the parts needing accounts are not mine.

**`@fastify/cors` installed at the wrong major.** `npm install` resolves it to v11, which
declares `fastify: '5.x'` in its plugin metadata against our Fastify 4.29 — registration would
have thrown at boot. The package declares no `peerDependencies`, so npm installed it silently.
Pinned to `^8.5.0`.

**An unset `CORS_ORIGINS` means `origin: false`, not `origin: true`.** A missing variable
should not make the API trust every origin. Verified: preflight from the Vercel origin answers
`204` with `authorization` allowed, and an untrusted origin gets no header at all.

**TLS is derived from the host, not from a flag.** `node-postgres` does not enable TLS by
default and Neon refuses plaintext, so the deployed instance would fail at boot. A `SSL=true`
variable is one more thing to forget; the pool decides from the hostname instead. **Unproven
against Neon** — there is no connection string yet, and I am not recording it as working until
it has connected once.

**The frontend needed an endpoint that did not exist.** There was no way to list rooms, so
rather than stub one, built the cross-venue search from ARCHITECTURE §5 — cheap predicates on
`rooms` first, availability `NOT EXISTS` last. A customer sees all 8 seeded venues, a venue
admin sees exactly one, so INV-6 holds there too.

**Blocked:** creating the Neon, Render and Vercel accounts is not something an agent should do
on my behalf, so seeding Neon and the live URLs wait on me.

---

### 18. A proof regression that was not one
**Delegated:** The proof started failing after a rebuild — 502s and 504s, only one replica
answering. Find it.

**Verdict:** `MODIFIED` — two wrong diagnoses before one measurement.

First guess was stale `HELD` rows from earlier runs piling into the exclusion index. Second was
pool exhaustion, on the strength of a `timeout exceeded when trying to connect` in the logs.
Both were plausible and both were wrong.

Measuring settled it in one query: 7 `HELD` rows in the whole database, and a single hold
returning `201` in 99 ms. Nothing was slow.

The actual cause was `docker compose up --build`, which recreated `api-1/2/3` with new
container IPs but left `lb` running. nginx resolves its upstreams once at startup and caches
them, so it was proxying to addresses that no longer existed. `docker compose restart lb` and
the proof passed 10/10.

**Worth keeping:** the two failed diagnoses were both consistent with the symptom, and the
number that killed them — 7 held rows — took less time to get than either theory took to
construct.

---

### 19. LOAD_TEST.md with no load test in it
**Delegated:** Fill `LOAD_TEST.md`, which was empty and is a named deliverable, without
inventing numbers.

**Verdict:** `ACCEPTED`

Nothing to override — the constraint was the point, and the useful part was deciding what
counts as evidence when the benchmark was never run. Recording the four targets and "not run"
against each is honest but worth little on its own. What made the file worth having was
measuring what *could* be measured on the demo profile and being explicit about its limits.

Two results came out of that, and one changed my mind. `rooms_search_idx` has
`idx_scan = 0` — the composite index §5 argued for carefully has never been used. The planner
drives the search from the amenities GIN and filters city, capacity and price on the heap.

The temptation was to write that up as the index being wrong. It is not: 64 rooms is two heap
blocks, and at that size no index choice can lose. The correct conclusion is narrower and less
satisfying — demo scale cannot answer the question §5 asked, and reading this plan as an answer
would be the error. That distinction is most of what the file is for.

The other result, 12,740 rows discarded per equipment check, needs no benchmark to act on and
is now first on the §8 list after the payment path.
