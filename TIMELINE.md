# TIMELINE.md

Times PKT. T0: 2026-08-22 12:00. Deadline: 2026-08-23 12:00.

---

### Aug 22 · 12:00–16:00 — Draft and discussion

Read the brief. Worked the concurrency problem before writing any code. Settled room and equipment mechanisms, resolved A1–A8.

Commit `d82c1ac` at 16:02 — ARCHITECTURE.md with §3, §4 (draft), §6. No hold endpoint existed.

**Cut:** clarifying questions. Every ambiguity was resolvable on defensible grounds.

### Aug 22 · 16:00–17:00 — Process rules
Extracted non-code obligations from the brief into PROCESS_RULES.md.

### Aug 22 · 17:00–22:00 — Rest

### Aug 22 · 22:00 — Re-read brief
Against first-pass notes.

### Aug 23 · 05:00–06:00 — Repo setup
CLAUDE.md written to constrain agent against locked design decisions and brief prohibitions. Six deliverable files created; graded ones left as empty structure.

**Cut:** nine-file raw/polished scratch scheme. Overhead, invites end-of-window reconstruction.

### Aug 23 · 06:00–07:00 — Order of work
Rejected agent plan that went straight to schema and deployment. Architecture is 35% of score with stubs. Order: finish architecture → stack → build.

### Aug 23 · 07:00–08:00 — Stack decided
TypeScript + Fastify + Postgres. No ORM. Plain `pg`, hand-written SQL, `.sql` migrations. Five DECISIONS entries.

### Aug 23 · 08:00–09:00 — Two gaps closed
ARCHITECTURE had nothing on tenant isolation (hard cap 3) or refund policy. Wrote §4A and §4B. A9, A10 added.

### Aug 23 · 09:00–10:00 — Refund idempotency and background work
§4C: cancellation is what's made idempotent, not refund — state machine already guarantees it. Refund intent in same transaction. A11 added. §4D: Postgres jobs with FOR UPDATE SKIP LOCKED.

### Aug 23 · 10:00–11:00 — First execution
Stack didn't start. 003 failed: `timestamptz + interval` is STABLE, not IMMUTABLE. Fixed. Then found three more: no venue check on hold path (hard cap 3), loose test, deadlocks answering 500 instead of 409.

Both testable hard caps now hold:

| Cap | Evidence |
|---|---|
| Concurrency proof | Phase A 1×201 / 199×409; Phase B 3×201 vs 3 units / 197×409; zero 5xx; all replicas |
| Cross-venue auth | 7/7 isolation tests, hold by direct UUID gets 404 and writes nothing |

**Cut:** Paygate, confirm, cancellation, refunds, reaper. Half-built payment path < proven concurrency core.

### Aug 23 · 11:00–12:00 — Deployment, ARCHITECTURE §7, §8
CORS, TLS, Render config, frontend. Frontend needed rooms listing — built cross-venue search from §5 (reverses earlier cut).

ARCHITECTURE §3.3 now has proof output. §7 has measured numbers. LOAD_TEST.md written but empty — no benchmark was run.

False alarm: proof returned 502s. nginx cached upstream IPs from containers recreated under it.

### Aug 23 · 12:00–13:00 — Deployed API, built frontend
API live on Render + Neon. `npm run verify:deployed` — 13 checks pass. Found: schema violations returned 500 with raw Zod (encapsulation trap, same as earlier). Fixed. Added `tests/error-mapping.test.ts`.

Replaced plain HTML with Next.js. App Router, TypeScript, Tailwind. Demo surface.

### Later — Frontend deployed
Frontend deployed to Vercel at https://atrium-studio-booking.vercel.app.

### Aug 25 — Two recorded defects closed
Both were in README Known Issues rather than fixed.

`TRUNCATE` produces no row events, so the 008 row triggers never fired for it and the audit trail was removable in one statement, cascade from `bookings` included. Migration 009 adds statement-level guards; the seed disables them explicitly, which requires ownership the app role does not hold.

Fastify's default `requestIdHeader` honoured an inbound `request-id` and skipped `genReqId`. Set to `false`. `x-correlation-id` is still accepted, now bounded to `^[A-Za-z0-9._:-]{8,128}$`.

`tests/append-only.test.ts`, `tests/correlation-id.test.ts`. Suite 24 green.

### Aug 25 — Seed volumes and date distribution
Demo was seeding 24,675 bookings and 64 rooms against a stated 25,000 and 60. Causes: per-venue counts multiplied up, and rows counted as written when `ON CONFLICT DO NOTHING` had dropped them.

Underneath that: the generator walked the calendar from the start of the window and stopped at the target, so all 250,000 full-profile bookings sat 13 to 18 months in the past, none in the present or future. Skip rate now derives from target over calendar capacity; status follows the date. Full profile now 47,671 future bookings, 38,006 in the exclusion index.

### Aug 25 — Benchmark
k6 as a compose service, brief's targets as thresholds. Availability 230.1 ms p95 against 300, search 55.6 against 500, hold 172.2 against 250. Zero errors. Revenue report is Tier 2 and unbuilt — not measured.

EXPLAIN, warm on both sides: `rooms_search_idx` present 18.76 ms, dropped 18.88 ms. 17 of those 18 ms are the availability anti-join. Recorded, not tuned.

**Cut:** a hand-rolled load driver, written and deleted before it ran. The brief names k6.

---

## Cuts

| Cut | Reason |
|---|---|
| Clarifying questions | Resolvable as assumptions |
| Raw/polished scratch files | Overhead |
| Paygate, confirm, cancellation, refunds, reaper | Time ran out after stack first ran. Concurrency core proven instead |
| ~~Cross-venue search~~ | Cut, then reversed — frontend needed it |

---

## Tier 3

Not started. Won't be while any Tier 1 item is incomplete. Brief states the trade openly — I'm taking it deliberately.