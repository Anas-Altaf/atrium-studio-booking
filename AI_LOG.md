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
