# AI_LOG.md

Verdicts: ACCEPTED / MODIFIED / REJECTED

---

### 1. Concurrency mechanisms — rooms and equipment
**Delegated:** Propose mechanisms for rooms and equipment that hold across three replicas, given the brief rules out check-then-insert and in-process memory.
**Returned:** GiST exclusion for rooms. For equipment, sum of overlapping quantities.
**Verdict:** MODIFIED — rooms accepted, equipment rejected.

The sum was wrong. Overlaps are partial — it counts units never simultaneously out. Replaced with maximum concurrent reservation at candidate points. The sum over-rejects rather than oversells, so INV-2 would have passed while legitimate bookings were quietly refused.

---

### 2. Turnaround gap and audit enforcement
**Delegated:** How to enforce 15-min room turnaround and exactly one AuditEvent per transition.
**Returned:** Turnaround inside `reserved_range` as geometry; transitions with a BEFORE UPDATE trigger that writes AuditEvent in the same statement.
**Verdict:** ACCEPTED.

---

### 3. Process rules extraction
**Delegated:** Consolidate the brief's non-code obligations into one file.
**Returned:** PROCESS_RULES.md with hard caps, timing gates, per-file duties, hosting constraints, scoring weights.
**Verdict:** ACCEPTED — used as cross-check against my own reading.

---

### 4. Repository scaffolding
**Delegated:** CLAUDE.md and skeletons for graded files.
**Returned:** Both instruction files plus AI_LOG, DECISIONS and TIMELINE filled with its own prose unasked, before architecture discussion had happened.
**Verdict:** MODIFIED.

Stripped back to structure. Added working agreement to CLAUDE.md — ask before writing, one file at a time, structure not prose.

---

### 5. Agent asserted repository state without checking
**Delegated:** Create the required files in the repo.
**Returned:** Files created in a scratch directory. Also claimed the design draft still needed pushing and the questions window was open.
**Verdict:** REJECTED.

Reasoned forward from the brief's timeline instead of reading what was on disk.

---

### 6. Plan for the remaining window
**Delegated:** With ~5.5 hours left and no code written, propose an order of work.
**Returned:** Schema → migrations → auth → hold endpoint → deployment.
**Verdict:** REJECTED.

Proposed starting with schema and deployment. Architecture is 35% of the score with §1, §2, §5, §7, §8 still stubs. Order corrected to: finish architecture → decide stack → build.

---

### 7. Stack proposal
**Delegated:** Propose a stack, given the design already fixed in ARCHITECTURE.md §3.
**Returned:** TypeScript + Fastify + Postgres, with Kysely as query layer.
**Verdict:** MODIFIED.

Kept the Prisma reasoning (right). Dropped Kysely — needs codegen I haven't used. In the live defense, a file holding literal SQL is easier to navigate than a builder API. Plain `pg` + hand-written SQL.

---

### 8. Tenant isolation mechanism
**Delegated:** Propose a mechanism for INV-6, noting ARCHITECTURE.md said nothing about it despite being a hard cap.
**Returned:** Three options: per-query WHERE venue_id, RLS, or mandatory scope parameter. Pooling hazard in RLS identified.
**Verdict:** ACCEPTED.

Pooling argument decided it — a session variable left on a returned connection serves the next request under the previous tenant's scope.

---

### 9. Refund policy — complexity I cut
**Delegated:** How to satisfy "policy is data" and "no retroactive change to CONFIRMED booking."
**Returned:** Versioned policy rows with booking holding a version pointer, plus a copy-on-write rule freezing a version when first referenced.
**Verdict:** MODIFIED.

Took the versioning. Cut the freezing rule — buys little for the machinery. Where useful: pushed back on my idea of letting an admin flag a "correction," pointing out the system can't verify a claimed correction. That became A10.

---

### 10. Refund idempotency
**Delegated:** How to guarantee double-clicking cancel refunds once.
**Returned:** Make cancellation idempotent (state machine already guarantees it via row lock). Write refund intent in same transaction. Worker drives it with derived Idempotency-Key.
**Verdict:** ACCEPTED.

Reframing from "one refund" to "one cancellation" made the problem disappear — the guarantee was already built. Pushed back on 409 for repeated cancel — settled as 200 with existing refund (A11).

---

### 11. Background job mechanism
**Delegated:** Queue service or Postgres for reaper, refund driver, webhook processor, sweeper.
**Returned:** Postgres with FOR UPDATE SKIP LOCKED. Dual-write argument: external queue makes enqueueing a second write; crash between commit and enqueue loses the job.
**Verdict:** ACCEPTED.

The dual-write argument was sharper here because the thing lost is money. SKIP LOCKED also answers the objection about three replicas colliding.

---

### 12. State machine, including failure edges
**Delegated:** Turn the brief's diagram into a full transition matrix with every failure edge.
**Returned:** Matrix plus table of refused transitions tied to Paygate chaos modes. Observed that EXPIRED → CONFIRMED can't simply be refused — must route to refund.
**Verdict:** ACCEPTED.

Two edges I added not in the brief's diagram: HELD → HELD for checkout re-issue (A1), HELD → CANCELLED for customer releasing a hold.

---

### 13. Schema and migrations
**Delegated:** Write migrations from agreed table shape, then ARCHITECTURE.md §1 and §5.
**Returned:** Migrations 001-008. Caught that my proposed composite index `(city, capacity, hourly_rate_minor)` wastes its third column — btree stops seeking after first range predicate. Shipped as `(city, capacity)`.
**Verdict:** MODIFIED.

What I changed: audit trigger read `actor_id` from a session variable — same mechanism I'd just rejected for RLS. Kept with SET LOCAL, inconsistency noted in migration comment. Not yet verified at this point (no Postgres available).

---

### 14. API core, compose stack, seed and concurrency proof
**Delegated:** Write the application: pool, migration runner, AuthScope, hold endpoint, error translation, docker compose with three replicas, seed script, concurrency proof.
**Returned:** Code with four defects found on review.
**Verdict:** MODIFIED.

1. Fastify encapsulation: auth and correlation plugins registered inside `app.register()` — decorators invisible to siblings. Wrapped with `fastify-plugin`.
2. Append-only documented but not active. App connects as owner — migration 006 revoking from `atrium_app` does nothing. Added migration 008: triggers that reject mutation from any role.
3. Duplicate equipment lines each capacity-checked against a peak not yet including the other. Merged before check.
4. Correlation id assigned via `req.id` mutation instead of `genReqId`. Log lines wouldn't carry it.

Got right: locking `equipment_types` in fixed id order. I hadn't thought about deadlock. Also corrected: proof fired 200 requests at the same room + equipment type — passes while proving nothing about equipment. Split into two phases.

---

### 15. First migration run
**Delegated:** Bring the stack up under docker compose, fix whatever blocks the hard caps.
**Returned:** Three defects.
**Verdict:** MODIFIED.

003 could never migrate — `timestamptz + interval` is only STABLE, not IMMUTABLE. Wrapped in IMMUTABLE function.

`createHold` had no venue check — hard cap 3. `assertVenueWritable` imported, re-exported, never called. Answered 404 not 403.

Test for that cap asserted `400 <= status < 500` — a 409 from the exclusion constraint would have passed against an unauthorised booking. Now 403|404 plus row-write assertion.

---

### 16. First 200-request proof run
**Delegated:** Run the proof against three replicas behind nginx.
**Returned:** Three defects.
**Verdict:** MODIFIED.

Stack never started: healthcheck used `localhost` (resolves `::1`), server binds `0.0.0.0`.

Deadlocks answered 500 — GiST at 200-way concurrency deadlocks. Invariant never at risk, status code was. Retried in `withTransaction`, then translated.

Fixture deleted previous run's rows — `audit_events` refuses. Per-run fixtures instead, deleting nothing.

---

### 17. Deployment preparation
**Delegated:** CORS, TLS to managed Postgres, Render service definition, frontend.
**Returned:** Four things to fix.
**Verdict:** MODIFIED.

`@fastify/cors` resolved to v11 (declares `fastify: '5.x'` against 4.29 — would have thrown at boot). Pinned to `^8.5.0`.

Nothing listed rooms — frontend had nothing to call. Built cross-venue search from §5.

TLS derived from hostname, not from a flag. Unproven against Neon. Accounts blocked.

---

### 18. Proof failing after a rebuild
**Delegated:** Proof started returning 502 and 504 after a rebuild. Find it.
**Returned:** nginx upstream IPs cached from old containers.
**Verdict:** MODIFIED.

`docker compose up --build` recreated api containers with new IPs and left lb running. nginx resolves upstreams once at startup. `docker compose restart lb`, proof passed 10/10.

---

### 19. LOAD_TEST.md
**Delegated:** Fill LOAD_TEST.md, which was empty and is a named deliverable, without inventing numbers.
**Returned:** Demo-profile EXPLAIN plans written up at length.
**Verdict:** MODIFIED.

Presenting query plans from a 64-room database as a load test dresses up work that was not done. Cut to targets, why not run, and method. Two plans worth keeping recorded in ARCHITECTURE.md instead.

---

### 20. Deploying found a bug the suite could not
**Delegated:** Deploy to Neon and Render, then verify the live instance.
**Returned:** Validation failure returned 500 carrying raw Zod issue list.
**Verdict:** MODIFIED.

`setErrorHandler` registered after route plugins — encapsulation context trap. Same issue as entry 14, three commits later. Tests asserted on status only, none on body. Added `tests/error-mapping.test.ts`.

---

### 21. Frontend
**Delegated:** Replace plain HTML page with a Next.js app, adding nothing beyond what the framework brings.
**Returned:** Scaffold with three type errors.
**Verdict:** MODIFIED.

Three errors: response logger lost type info (`ApiResult<unknown>`), React components without importing React (modern JSX transform doesn't provide it), `init.headers` spread into HeadersInit (union type doesn't spread safely).

Design point worth keeping: page reports how many distinct venues a search returns. Cheapest INV-6 demonstration — customer sees eight, admin sees one, produced by the API.

---

### 22. TRUNCATE guard and the correlation id
**Delegated:** Close two holes already in README Known Issues — TRUNCATE walking past the append-only triggers, and Fastify's `request-id` overriding `genReqId`.
**Returned:** Migration 009 with statement-level guards, `requestIdHeader: false`, plus validation on `x-correlation-id` that was not asked for.
**Verdict:** MODIFIED — the validation was unrequested scope.

Rejected its first instinct on the seed: a session flag the guard consults is an escape hatch any code path can open. `DISABLE TRIGGER` needs ownership instead.

---

### 23. Seed volumes
**Delegated:** Make the seed produce the volumes the brief states. Demo was at 24,675 bookings and 64 rooms against a stated 25,000 and 60.
**Returned:** Totals spread across venues, count taken from `rowCount`. Then a rewrite of the date distribution, unasked.
**Verdict:** MODIFIED.

Two count bugs: per-venue figures multiplied up, and rows counted as written when `ON CONFLICT DO NOTHING` had dropped them. Underneath: all 250,000 full-profile bookings sat 13 to 18 months in the past, so every availability query met an empty calendar. New defect — should have been raised, not fixed in the same pass.

---

### 24. Full-profile benchmark
**Delegated:** Benchmark `--profile=full` and produce LOAD_TEST.md.
**Returned:** A hand-rolled Node load driver; then k6 as a compose service after that was rejected.
**Verdict:** MODIFIED.

The driver was argued on autocannon lacking p95, which is true, and on k6 needing a binary install, which is not — it ships a Docker image, and the brief names k6. Three further errors: 409s counted as failed requests, hold latency averaged over 201s and 409s, and a first EXPLAIN pass that compared a cold plan against a warm one.
