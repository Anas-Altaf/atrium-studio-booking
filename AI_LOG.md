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
