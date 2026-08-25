# CLAUDE.md

Read this before any code change. These are constraints, not suggestions.

---

## Three hard caps — check before every change

1. **200-request concurrency proof must not double-book.** 3 replicas, same room, same slot: 1 success, ≤3 equipment units, 199 clean 409s. Zero 5xx.
2. **System must stay deployed and reachable.** Frontend + API both live.
3. **Cross-venue authorisation must hold.** Venue A admin never reads/writes Venue B data, even with a valid Venue B UUID.

A change that risks any of these must be stopped and flagged before code is written.

---

## What exists vs. what doesn't

### Built (tested, deployed)
- Auth with 4 roles + JWT bearer tokens
- Create hold with equipment line items (INV-1, INV-2)
- Cross-venue room search with filters
- Cross-venue isolation (INV-6) — 7 tests pass, deployed 13/13
- 200-request concurrency proof — Phase A 1×201/199×409, Phase B 3×201/197×409
- Append-only audit enforcement (layer 2: triggers, layer 3: TRUNCATE guards)
- Error handling (400/401/404/409 shapes, correlation id on every response)
- Paygate mock provider with all 6 chaos modes
- Checkout → charge → confirm flow
- Webhook handler + SKIP LOCKED worker
- Retry driver for refunds
- Seed script (`--profile=demo` and `--profile=full`)
- Full-profile benchmark with k6 (p50/p95/p99, EXPLAIN before/after, machine spec)
- Health endpoint that checks the database

### Schema only (migrated, no code calls it)
- Policy versioning for refunds — every booking has a `policy_version_id`, nothing reads it

### Not built
- Cancellation endpoint + refund calculator
- Hold reaper (expired bookings block their slot forever right now)
- Reconciliation report (INV-5)

---

## Absolute prohibitions

| Never | Why |
|---|---|
| In-process lock (mutex, semaphore, in-memory map) | Passes on one replica, fails on three |
| SELECT for conflicts, then INSERT | Read-then-write race — the brief's named failure |
| `UPDATE bookings SET status = ?` outside the state machine trigger | The trigger must validate every transition |
| 500 for an illegal transition or a lost race | Must be clean 409 |
| `UPDATE` or `DELETE` on audit_events | Trigger rejects it |
| Auth that lives only in the frontend | Treated as absent |
| Stock/counter column for equipment | No time dimension |
| Heavy work inline in webhook handler | Must: verify → dedup → enqueue → 200 |
| Silent drop or 500 on webhook for unknown charge | Write to `unmatched_webhooks`, return 200 |
| Squashed commit history | One squashed commit scores zero on process |

---

## Code conventions

- **Stack:** TypeScript, Fastify, `node-postgres`. No ORM, no query builder — hand-written SQL in repositories, `.sql` migrations.
- **Parameterized queries only.** `$1`, `$2`, `$3`. Never concatenate or template-interpolate user input into SQL — not in seeds, scripts, or any code path.
- **Routes → service → repository.** No SQL in route handlers.
- **Any repository method that can return a row the caller has not already proved access to takes `AuthScope` as its first parameter**, and turns it into a predicate the query carries. The rest take an explicit `venue_id` the calling service got from a scoped read, so they cannot widen reach. Two exceptions: `userRepo.findByEmail` (runs before the caller has an identity) and `systemRepo` (no tenant data). Adding a repository read that takes neither is an INV-6 hole — INV-6 is a hard cap.
- **Database errors translate at the repository boundary.** Postgres error codes never leak as raw exceptions. `translatePgError()` in `errors.ts`.
- **Transactions through `withTransaction()`.** It sets `SET LOCAL atrium.actor_id` and `atrium.reason`, retries `40P01` deadlocks once, translates surviving contention to 409.
- **Lock equipment types in sorted id order** before inserting a booking. Two holds on the same types in opposite order deadlock.
- **Proof fixture is per-run, never deletes.** Every object tagged with a run id. Audit events are append-only — the fixture cannot clean up after itself.
- **Correlation id via `genReqId`**, not by mutating `req.id` in a hook. Accepts inbound `x-correlation-id`. Response carries `x-served-by` (which replica).
- **Error handler must be set before `app.register()` calls.** A plugin registered with `app.register()` captures the error handler in force at that moment in its encapsulation context — a handler set afterwards never applies.
- **`fastify-plugin` wrapper** on any plugin that adds decorators or hooks. Without it, those live in the plugin's encapsulation context and are invisible to sibling plugins.

---

## Working rules

- **Ask before writing.** Say what and how long. Wait for a yes.
- **One file, one change per turn.** Never fill several documents in one pass.
- **Graded files (`AI_LOG.md`, `DECISIONS.md`, `TIMELINE.md`, `ARCHITECTURE.md`):** provide structure, headings, format. Do not write the prose — that belongs to the author.
- **AI_LOG.md:** entry for every delegation with Delegated/Returned/Verdict. ACCEPTED/MODIFIED/REJECTED. Three lines each.
- **Don't draft ahead.** Write what was asked for and stop.
- **Don't assign work to the author.** The agent does the writing or says "I cannot do this."

---

## Broken things that are logged, not hidden

If you find a new defect or a missing edge case, log it in `AI_LOG.md` and add it to `README.md` Known Issues. Don't fix it without asking — the author decides what to fix vs. what to document and move on.