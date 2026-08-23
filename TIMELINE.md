# TIMELINE.md

Hour by hour. What was done, what was cut, why. Times PKT.

| | |
|---|---|
| T0 (brief received) | 2026-08-22 · 12:00 |
| Deadline | 2026-08-23 · 12:00 |

---

## Log

### Aug 22 · 12:00–16:00 — Draft and discussion
Read the brief. Worked the concurrency problem before writing any application code.
Settled the mechanism for rooms and for equipment, and resolved eight ambiguities as A1–A8.

Commit `d82c1ac` at 16:02 — ARCHITECTURE.md pushed with §3, §4 (draft) and §6.
No hold endpoint existed in the repository at this commit.

**Cut:** the clarifying-questions batch. Every ambiguity was resolvable on defensible
grounds; documented as assumptions instead.

### Aug 22 · 16:00–17:00 — Process rules
Extracted the non-code obligations from the brief into PROCESS_RULES.md: hard caps, timing
gates, per-file duties, test obligations, hosting constraints, scoring weights.

### Aug 22 · 17:00–22:00 — Rest

### Aug 22 · 22:00 — Requirements re-read
Read the brief again in depth, independently, against the notes from the first pass.

### Aug 23 · 05:00–06:00 — Repository setup
CLAUDE.md written to constrain agent behaviour against the locked design decisions and the
brief's prohibitions. Six deliverable files created; the graded ones left as empty structure.

**Cut:** a nine-file raw/polished scratch scheme. Overhead under this clock, and a
raw/polished split invites reconstructing a clean narrative at the end.

### Aug 23 · 06:00–07:00 — Repo pushed, order of work settled
Pushed to `atrium-studio-booking`. Added a logging cadence to CLAUDE.md so the graded files
are updated after every work block.

Rejected an agent plan that went straight to schema and deployment. Architecture is 35% of
the score and §1, §2, §5, §7, §8 are still stubs; writing schema before the ERD and state
machine are settled would mean migrating twice. Order: finish architecture → decide stack →
build.

### Aug 23 · 07:00–08:00 — Stack decided
TypeScript + Fastify + Postgres, no ORM and no query builder — plain `pg` with hand-written
SQL in repository classes and plain `.sql` migrations. Five entries written to DECISIONS.md.

The order mattered: because the concurrency strategy was fixed first, Postgres was a
consequence of INV-1 rather than a preference, and Prisma was ruled out on what it cannot
express rather than on taste.

### Aug 23 · 08:00–09:00 — Two gaps in the architecture closed
Found that ARCHITECTURE.md said nothing about tenant isolation despite INV-6 being a hard cap,
and nothing about how the refund policy avoids retroactive changes despite the brief asking
for it explicitly.

Both settled and written as §4A and §4B. Chose repository-level mandatory scoping over
Postgres RLS (pooling creates a new isolation failure mode), and immutable policy versions
over mutable rows. Assumptions A9 and A10 added.

**Cut:** a copy-on-write rule that would have kept a policy version editable until first
referenced. Correct, but more machinery than the problem deserves and harder to defend in one
sentence.

### Aug 23 · 09:00–10:00 — Refund idempotency and background work
§4C: cancellation is the thing made idempotent, not the refund — the state machine already
guarantees it. Refund intent written in the same transaction as the transition. A11 added on
the literal reading of "illegal transition".

§4D: background jobs in Postgres with `FOR UPDATE SKIP LOCKED`, worker inside the API process.
Redis rejected on the dual-write argument.

---

## Cuts

| Cut | Reason |
|---|---|
| Clarifying-questions batch | Ambiguities resolvable; documented as A1–A8 |
| Raw/polished scratch files | Overhead; invites end-of-window reconstruction |

---

## Tier 3

Not started, and will not be while any Tier 1 item is incomplete. The brief states the trade
openly and I am taking it deliberately.
