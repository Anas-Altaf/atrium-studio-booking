# DECISIONS.md

Target 8–15 entries. Added at the moment of choosing.

---

### 1. Architecture settled before the stack
**Chose:** Fix the concurrency strategy first, then pick the stack that serves it.
**Rejected:** Picking a familiar stack first and designing inside its constraints.
**Trade-off:** The stack is now constrained rather than free — Postgres is effectively
mandated. Accepted because the concurrency model is the graded core, and a stack chosen first
would have quietly limited which mechanisms were available.

---

### 2. Backend first, frontend as presentation
**Chose:** Spend the window on the API and database. The frontend is a thin surface over it.
**Rejected:** Building the two in parallel.
**Trade-off:** The UI will be plain and may cover only the demo path. Accepted because every
graded invariant, all three hard caps, and the entire concurrency proof live server-side —
authorisation that exists only in the frontend is explicitly treated as absent.

---

### 3. PostgreSQL — required by the design, not chosen for preference
**Chose:** Postgres, because `EXCLUDE USING gist`, range types and generated columns are what
INV-1 is built on.
**Rejected:** MySQL — no exclusion constraints, so room overlap would fall back to
application-level checking, which is the failure mode the brief names.
**Trade-off:** The database is no longer swappable. This follows from decision 1 rather than
being an independent choice.

---

### 4. TypeScript + Fastify
**Chose:** Node with TypeScript, Fastify for the HTTP layer.
**Rejected:** Python + FastAPI — an equally good fit for this design.
**Trade-off:** Chosen for familiarity under a 24-hour clock, not on technical merit. The cost
is that Node's single-threaded model makes CPU-bound work awkward, which is acceptable here
because the application layer is deliberately thin — the database does the work.

---

### 5. No ORM and no query builder — plain `pg` with hand-written SQL
**Chose:** `node-postgres` directly, SQL written by hand in repository classes, migrations as
plain `.sql` files.
**Rejected:** Prisma.
**Trade-off:** No compile-time checking of column names, and more code for simple CRUD.
Accepted because Prisma cannot express any of `EXCLUDE USING gist`, generated columns,
triggers, `REVOKE`, or `SELECT ... FOR UPDATE` — every one of which this design depends on.
They would all become raw migration SQL, leaving `schema.prisma` permanently drifted from the
real schema and creating a second source of truth. The ORM would be bypassed at exactly the
points that matter while still costing setup time and a query-engine binary.

Kysely was also considered and rejected: it solves the typing problem without hiding the SQL,
but it needs codegen setup I have not used before, and there is a live defense in which I must
navigate and modify this codebase from memory. A repository file containing the literal SQL
that Postgres will execute is the most navigable option available.

**Mitigations for the accepted risk:** parameterized queries only, hand-written row interfaces
per query, and an integration test per repository method.

---

<!--
Format:

### N. <Decision>
**Chose:**
**Rejected:**
**Trade-off:**

Still open: hosting (backend, DB, frontend), webhook worker mechanism,
load-test tool, test framework, CI.
-->
