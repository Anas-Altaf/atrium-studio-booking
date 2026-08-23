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

### Aug 23 · 10:00–11:00 — First execution, and what it cost
Ran the stack for the first time. It did not start: `003` failed on
`generation expression is not immutable`, because `timestamptz + interval` is only STABLE.
Wrapped in an IMMUTABLE function. Every migration after it applied unchanged, so this was the
only blocker — but it had been sitting there since the schema was written, unexecuted.

That run then exposed three more: no venue check on the hold path at all (hard cap 3), an
isolation test too loose to have caught it, and 200-way deadlocks on the exclusion constraint
answering `500` instead of `409`. All four fixed and verified.

Both testable hard caps now hold, against a seeded database and three replicas:

| Cap | Evidence |
|---|---|
| Concurrency proof | Phase A 1 × 201 / 199 × 409; phase B 3 × 201 against 3 units / 197 × 409; zero 5xx; all three replicas |
| Cross-venue authorisation | 7/7 isolation tests, including a hold by direct room UUID answering 404 and writing nothing |

**Cut:** Paygate, confirm, cancellation, refunds, the reaper and cross-venue search. Roughly an
hour was left after the stack ran, and a half-built payment path is worth less than a proven
concurrency core with the gap written down. Recorded in README.

**Cut:** two known defects, documented rather than fixed — the `request-id` header overriding
the correlation id, and `TRUNCATE` bypassing the append-only triggers.

### Aug 23 · 11:00–12:00 — Deployment prep, and the 100x section

Deployment is the one hard cap still unmet, so it went first. CORS, TLS to a managed Postgres,
a Render service definition and a one-page frontend are written and verified locally. Seeding
Neon and the live URLs are blocked on accounts only I can create.

Building the frontend turned up something the cut list had wrong: there was no way to list
rooms. Rather than stub it, built the cross-venue search from §5 — so the search endpoint
recorded as cut in the hour above is in after all, with the real filter order. That reverses
the cut rather than hiding it.

Spent the rest on ARCHITECTURE, which is 35% and had two sections still reading `TBD`:

- §3.3 now carries the actual proof output, which the brief asked for explicitly. It was not
  there before.
- §7 is measured rather than argued: the GiST index at 1,592 kB today against 128 MB of shared
  buffers, an `EXPLAIN` showing 12,740 rows discarded per equipment check on a 24,680-row
  table, and `audit_events` sitting on the write path of every transition. Three failure modes,
  three remedies, one candidate ruled out.
- §3.5 keeps its original claim about role-level revokes and carries a note beneath it saying
  what was actually found. §4 is relabelled: specified, not implemented.

One false alarm cost about fifteen minutes. The proof started returning 502s after a rebuild
and I guessed twice — stale holds, then pool exhaustion — before measuring. It was nginx
caching upstream IPs for containers that had been recreated underneath it. Logged as AI_LOG 18,
because the guessing is the part worth remembering.

**Still open:** `LOAD_TEST.md` is empty, and it is a named deliverable.

---

## Cuts

| Cut | Reason |
|---|---|
| Clarifying-questions batch | Ambiguities resolvable; documented as A1–A8 |
| Raw/polished scratch files | Overhead; invites end-of-window reconstruction |
| Paygate, confirm, cancellation, refunds, reaper | No window left after the stack first ran; concurrency core proven instead |
| ~~Cross-venue search~~ | Cut at 11:00, then reversed — the frontend needed it and §5 already had the query |

---

## Tier 3

Not started, and will not be while any Tier 1 item is incomplete. The brief states the trade
openly and I am taking it deliberately.
