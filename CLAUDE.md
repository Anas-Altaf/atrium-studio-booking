# CLAUDE.md

Instructions for any AI agent working in this repository.
Read this before touching anything. It is not background reading — it is a set of constraints.

---

## 1. What this repository is

**Project Atrium** — a studio booking platform, built as a 24-hour technical assessment.
Two inventory types: **Rooms** (interval exclusion — never overlap) and **Equipment**
(quantity over an interval — never exceed units owned at any instant).

**This is not a feature-count exercise.** It is graded on:

| Dimension | Weight |
|---|---|
| System design and architecture | 35% |
| Code quality, structure and testing | 27% |
| Completeness and prioritisation | 22% |
| DevOps and observability | 16% |

Roughly 57% is won by judgment and documentation, not by shipping more endpoints.

---

## 2. Three hard caps — check before every change

These cap the **total score** regardless of everything else being perfect.

1. **The concurrency proof must not oversell or double book.** 200 concurrent requests,
   three replicas: exactly 1 room booking, ≤3 equipment units, all others clean `409`.
2. **The system must be deployed and reachable.** Frontend and API both live.
3. **Cross-venue authorisation must not be bypassable.** Including by direct UUID.

If a proposed change puts any of these at risk, stop and say so before writing code.

---

## 3. Locked architectural decisions

These were settled in the pre-code design commit. **Do not silently change them.** If you
believe one is wrong, say so explicitly and wait — do not implement an alternative.

### Rooms — GiST exclusion constraint
`EXCLUDE USING gist (room_id WITH =, reserved_range WITH &&)` partial on
`status IN ('HELD','PENDING_PAYMENT','CONFIRMED')`. `reserved_range` is a generated
`tstzrange` of `[start_at, end_at + 15 minutes)` — the turnaround gap is **geometry, not a
validation branch**, so no code path can bypass it.

`23P01` (`exclusion_violation`) is caught at the repository boundary and mapped to `409`.
It must never surface as a 500.

### Equipment — row lock + interval peak check
`SELECT ... FROM equipment_types WHERE id = $1 FOR UPDATE` in the same transaction as the
insert, then a **maximum-concurrent-reservation** check.

**A sum of overlapping quantities is wrong.** Overlaps are partial. The correct question is
peak usage at any instant inside the requested window, evaluated at candidate points
(requested `start_at`, plus the `start_at` of every overlapping booking inside the window).
Admissible iff `max(point_sums) + requested_qty <= effective_capacity`.

`effective_capacity = floor(units_owned * (1 + overbooking_buffer))`.

### State transitions — database trigger
A `BEFORE UPDATE` trigger validates `(from_state, to_state)` and writes the `AuditEvent` in
the same statement. `UPDATE` and `DELETE` are revoked on `audit_events` at the role level.

### Payments — dedup on business effect
`X-Paygate-Delivery` is new on every attempt and is **useless as a dedup key**. Uniqueness
is on `(charge_id, event_type)`. HMAC verified against the **raw body before parsing**.

---

## 4. Absolute prohibitions

Violating any of these is a scoring failure, not a style issue.

| Never | Why |
|---|---|
| Any in-process lock — mutex, semaphore, in-memory map of held slots | Passes on one replica, fails on three. Explicitly named in the brief as a failure |
| `SELECT` for conflicts, then `INSERT` | The named failure mode. Read-then-write race |
| `UPDATE bookings SET status = ?` outside the state machine | Explicitly called a fail |
| Returning `500` for an illegal transition or a lost race | Must be a clean `409` |
| `UPDATE` or `DELETE` on `audit_events` | Append-only is a database guarantee here |
| Authorisation checks that exist only in the frontend | Treated as absent |
| A stock/counter column for equipment | Has no time dimension. Explicitly ruled out |
| Deploying to Railway or Fly.io | No free tier. Explicitly banned |
| Anything requiring a credit card | Zero cost is a hard requirement |
| Heavy work inline in the webhook handler | Must be: verify → dedup insert → enqueue → 200 |
| Silently dropping or 500-ing a webhook for an unknown charge | Persist to `unmatched_webhooks`, return 200, resolve via sweeper |
| Squashing commit history | A single squashed commit scores zero on process |

---

## 5. Documentation duties — non-negotiable

These files are **graded deliverables**. They are maintained *during* the work, not written
at the end. Writing them afterwards is detectable and is specifically what the assessment
is designed to catch.

| File | When to update | What goes in |
|---|---|---|
| `AI_LOG.md` | **After every delegation** | See section 6. Not a mistake list |
| `DECISIONS.md` | At the moment of choosing | Choice, one rejected alternative, trade-off accepted. Three lines |
| `TIMELINE.md` | Hourly | What was done, what was cut, why |
| `ARCHITECTURE.md` | As design evolves | Never quietly rewrite. Contradictions stay in with a note |
| `LOAD_TEST.md` | After benchmarking | Script, p50/p95/p99/error rate, machine spec, EXPLAIN before/after |
| `README.md` | Continuously | Setup + a blunt "Known Issues and What I Did Not Finish" |

Full non-code obligations — deliverables, timing gates, test obligations, hosting constraints,
submission format, pre-submission checklist: see `PROCESS_RULES.md`.

### The no-quiet-rewrite rule

If implementation contradicts the pre-code design draft, **leave both in the document** and
note what changed and why. The brief states that discovering mid-build that the first
approach was wrong is good engineering. Concealing it is the failure.

Agents tend to "clean up" contradictions. **Do not.** Preserving them is worth marks.

---

## 6. AI_LOG protocol

`AI_LOG.md` records **what was delegated**, not merely what went wrong. Every non-trivial
delegation gets an entry, including ones where the output was accepted unchanged — that is
the evidence of division of labour.

Every entry carries a verdict:

- **ACCEPTED** — used as produced, after review
- **MODIFIED** — used with named changes (say exactly what and why)
- **REJECTED** — discarded, with the reason and what replaced it

Reporting zero agent mistakes is explicitly called a disqualifying signal in the brief:
it means either the output was not reviewed, or the candidate is not being straight.
So **REJECTED and MODIFIED entries are the valuable ones** — do not smooth them over.

When you produce something and it is corrected, **write the correction into `AI_LOG.md`
yourself**, honestly, including what you got wrong.

---

## 7. Build order

Do not start a lower tier until the tier above is correct, tested and deployed.

**Tier 1 (MUST)** — auth with four roles + enforced venue-scoped authorisation · availability
query + cross-venue search · hold/pay/confirm with equipment line items · all six invariants
with the 200-request proof passing · Paygate to spec with chaos on · cancellation with
data-driven refund policy · append-only audit trail · seed script with both profiles,
deployed on demo and benchmarked locally on full

**Tier 2 (SHOULD)** — venue admin console · reconciliation report · revenue and utilisation
report · structured logging with a correlation ID surviving into the webhook path · a health
endpoint that checks dependencies · CI on every push

**Tier 3 (COULD)** — realtime heatmap · natural language booking · recurring bookings ·
waitlist · notifications

**Do not propose Tier 3 work.** The brief states it was made deliberately more fun and more
demo-visible than a correct locking strategy, and that a beautiful calendar with a race
condition scores *below* a plain submission with Tier 1 correct.

---

## 8. The six invariants

| # | Invariant |
|---|---|
| INV-1 | Rooms never double book — not at 5 concurrent requests, not at 200 |
| INV-2 | Equipment never oversells — a question about intervals, not totals |
| INV-3 | A booking is charged at most once — regardless of retries, redelivery, or ordering |
| INV-4 | Expired holds are unconfirmable — if payment lands late, refund automatically and audit the sequence |
| INV-5 | Money is never silently lost — every capture maps to one CONFIRMED booking or one refund; a reconciliation endpoint proves it |
| INV-6 | Tenant isolation holds — through any endpoint, including by direct ID |

---

## 9. Operating rules

| Rule | Value |
|---|---|
| Hold TTL | 8 minutes from creation |
| Checkout window | ≥10 minutes from reaching checkout (see Assumption A1 — the hold is re-issued) |
| Granularity | 30-minute increments |
| Duration | Min 1 hour, max 8 hours |
| Advance window | 1 hour to 90 days ahead |
| Room turnaround | 15 minutes between consecutive bookings |
| Overbooking buffer | Up to 10%, **equipment only** (see Assumption A2) |
| Operating hours | Bookings must fall inside the venue's published hours for that weekday |

**Refund policy is data, not code.** A venue admin changes tiers through the API and it takes
effect immediately with no deployment. A policy change must **not** retroactively alter the
terms of an already CONFIRMED booking.

---

## 10. Code conventions

- **Stack:** TypeScript + Fastify + `node-postgres`. **No ORM, no query builder.** SQL is
  hand-written in repository classes; migrations are plain `.sql` files. Do not introduce
  Prisma, TypeORM, Drizzle or Kysely — see `DECISIONS.md` §5.
- **Parameterized queries only.** `$1`, `$2` placeholders. Never build SQL by string
  concatenation or template interpolation of user input, in any code path, including seeds
  and scripts.
- **Layered.** Routes → service → repository. No SQL in route handlers.
- **Database errors are translated at the repository boundary.** Postgres error codes never
  leak upward as raw exceptions.
- **Every mutating endpoint is authorised server-side**, scoped by venue, before any read.
- **Tests target risky logic** — the state machine, the refund calculator, the concurrency
  paths — not trivial getters.
- **Structured logs with a correlation ID** that survives into the webhook path.
- Commit messages are honest and descriptive. Commit frequently.

---

## 11. Working agreement

- **Ask before writing.** Say what you intend to write and how long, and wait. This applies
  to every file except this one.
- **One file, one entry at a time.** Never fill several documents in a single pass.
- **In graded files — `AI_LOG.md`, `DECISIONS.md`, `TIMELINE.md`, `ARCHITECTURE.md` — the
  content belongs to the author, not the agent.** Provide structure, headings and format.
  Do not write the prose.
- **Keep it short.** There is a live defense with no notes. Anything the author did not think
  through cannot be defended, so volume produced by the agent is a liability, not an asset.
- **Do not draft ahead.** Write what was asked for, and stop.

### Logging cadence

After every work block, before moving on:

1. `AI_LOG.md` — one entry per delegation, with a verdict
2. `TIMELINE.md` — at the end of every hour: what was done, what was cut
3. `DECISIONS.md` — any choice made, at the moment of choosing
4. Ask before committing

Ask before writing each entry. Never skip a block silently — if nothing is worth logging,
say so and wait.

---

## 12. When you are unsure

The clarifying-questions window has closed. Every remaining ambiguity is resolved
independently and recorded in `ARCHITECTURE.md` §6 "Assumptions".

If you hit an ambiguity while working: **stop, state it plainly, and propose a resolution.**
Do not pick silently. An undocumented assumption is worth nothing; a documented one is worth
marks.

---

## 13. Live defense constraint

Within 48 hours of submission there is a 30-minute call. Two design decisions must be
defended **without notes**, and a live change request implemented on the call.

**This changes what "good code" means here.** A cleverer mechanism that cannot be explained
from memory is worse than a simpler one that can. Prefer the design the author fully
understands. Keep the system small enough to navigate live.
