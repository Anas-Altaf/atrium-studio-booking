# DECISIONS.md

---

### 1. Architecture before stack
**Chose:** Fix concurrency strategy first, then pick the stack that serves it.
**Rejected:** Picking a familiar stack first and designing inside its constraints.
**Trade-off:** Postgres effectively mandated. The concurrency model is the graded core.

---

### 2. Backend first, frontend as presentation
**Chose:** Spend the window on the API and database. Frontend is a thin surface.
**Rejected:** Building in parallel.
**Trade-off:** Plain UI, covers demo path only. Invariants live server-side.

---

### 3. PostgreSQL — required by the design
**Chose:** Postgres — EXCLUDE USING gist, range types, generated columns.
**Rejected:** MySQL — no exclusion constraints, falls back to check-then-insert race.
**Trade-off:** DB is no longer swappable. Follows from decision 1.

---

### 4. TypeScript + Fastify
**Chose:** Node with TypeScript, Fastify.
**Rejected:** Python + FastAPI.
**Trade-off:** Familiarity under a 24-hour clock. Node's single-threaded model is fine here — the DB does the work.

---

### 5. No ORM — plain `pg`
**Chose:** `node-postgres`, hand-written SQL in repositories, plain `.sql` migrations.
**Rejected:** Prisma (can't express exclusion constraints, triggers, FOR UPDATE — would be bypassed at every point that matters). Kysely (needs codegen I haven't used, harder to navigate in live defense).
**Trade-off:** No compile-time column checking. Mitigated by parameterized queries everywhere and integration tests per repo method.

---

### 6. Tenant isolation by mandatory scope
**Chose:** Every repository method takes AuthScope as first param. No overload without it.
**Rejected:** Postgres RLS — pooled connection with a session variable left set serves next request under wrong tenant. New failure mode created by the safety mechanism.
**Trade-off:** Compile-time guarantee, not DB. psql bypasses it. RLS listed as next step.

---

### 7. Refund policy as immutable versions
**Chose:** refund_policy_versions is append-only. Booking holds a version pointer at creation.
**Rejected:** Mutable rows with terms copied onto each booking. Also rejected: "correction" flag — system can't verify a claimed correction.
**Trade-off:** Join at refund time. Guarantee holds structurally. Policy history for free.

---

### 8. Refund idempotency through state machine
**Chose:** Make cancellation idempotent (state machine already guarantees it), not the refund. Refund intent written in same transaction as transition.
**Rejected:** Client-supplied Idempotency-Key on cancel — double-click in naive UI produces two keys.
**Trade-off:** Eventually consistent refund. Doesn't depend on client behaviour.

---

### 9. Background jobs in Postgres, not a queue
**Chose:** Job rows polled with FOR UPDATE SKIP LOCKED. Worker inside API process.
**Rejected:** Redis + BullMQ — enqueueing is a second write that can fail after commit.
**Trade-off:** ~1s polling latency per replica. No dual-write problem, no extra service.

---

### 10. Deadlock is a lost race, not a 500
**Chose:** Retry 40P01 in withTransaction, translate to 409 if it survives retry.
**Rejected:** Advisory lock per room (second concurrency mechanism on top of what the DB already enforces), or letting it surface as 500.
**Trade-off:** Hold transaction may run more than once — safe because the victim is fully rolled back.
---

### 11. Append-only enforced in layers, and the seed disables it in the open
**Chose:** Privilege (006) + row triggers (008) + statement-level TRUNCATE guards (009). The seed calls `ALTER TABLE ... DISABLE TRIGGER`, which requires ownership.
**Rejected:** A session flag (`SET LOCAL atrium.allow_truncate`) the guard consults — an escape hatch any code path can open turns the guard back into a convention.
**Trade-off:** The seed can no longer run as the application role. That is the point: seeding is a migrator-role operation, and now the database says so rather than the README.
