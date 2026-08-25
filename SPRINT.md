# SPRINT.md

Working plan for the rest of Tier 1. Not a deliverable — tracking only.

**Branch:** `tier-1` · **Team:** 1 · **Length:** milestone-based, no fixed dates

**Goal**

> All six invariants provable against the deployed instance. Today that means the
> whole money path: INV-3, INV-4 and INV-5 have schema and no code.

---

## Carryover

| Item | Why it did not ship |
|---|---|
| Paygate, pay/confirm, cancel, refunds, reaper | Aug 23 window closed. Proving the concurrency core was chosen over a half-built payment path. Recorded in TIMELINE. |
| Reconciliation | Would have returned zero against an empty ledger — a false pass. |
| Availability endpoint | Cross-venue search covered the demo need. |

Re-committed because the reason is gone: no deadline pressure, and this is Tier 1.

---

## Milestones

| # | Milestone | Scope | Depends on | Size | Status |
|---|---|---|---|---|---|
| M1 | Paygate | Mock provider to spec. Six chaos behaviours behind `PAYGATE_CHAOS`. Seeded PRNG + `X-Paygate-Force` header so tests are deterministic. Compose service, plus `PAYGATE_EMBEDDED` for the free tier. | — | 3h | **done** — 12 tests, compose service healthy. Embedded flag deferred to M6, where the deploy happens |
| M2 | Money moves (chaos **off**) | `POST /bookings/:id/pay`. Webhook receiver: raw-body HMAC, dedup insert on `(charge_id, event_type)`, 200, no work inline. Worker loop + charge submitter + webhook processor. | M1 | 5h | not started |
| M3 | Chaos **on** — INV-3, INV-4 | Hold reaper. Unmatched-webhook sweeper. INV-4 branch: capture landing on an expired hold routes to refund, never CONFIRMED. Bad signature 401 and logged. Duplicate and out-of-order idempotent on business effect. | M2 | 5h | not started |
| M4 | Cancellation and refunds | Refund calculator as a pure function with unit tests at every tier boundary. Cancel endpoint writing transition and refund intent in one transaction. Refund driver job. `PATCH /venues/:id/policy`. | M3 | 4h | not started |
| M5 | Proof surface | `GET /reports/reconciliation` — three anti-joins (INV-5). `GET /rooms/:id/availability`. | M4 | 2h | not started |
| M6 | Ship | Redeploy with worker and embedded Paygate. Extend `verify:deployed`. Reseed, re-run benchmark. ARCHITECTURE §2 failure edges and §4 updated. README Known Issues. Five-minute walkthrough. | M5 | 3h | not started |

Sizes are relative, not a schedule.

**P0** — M1 to M4. Without these, "all six invariants" is untrue.
**P1** — M5. INV-5's own definition names an endpoint, so it is Tier 1.
**P2** — Tier 2 (admin console, revenue report, CI). Only after M6.

---

## Done when

| M | Condition |
|---|---|
| M1 | Chaos off: a charge returns 202 and a signed webhook reaches a stub endpoint |
| M2 | login → hold → pay → webhook → CONFIRMED, one end-to-end test green |
| M3 | Suite green with chaos **on**, zero 5xx in the logs, INV-3 and INV-4 each with a named test |
| M4 | A repeated cancel returns 200 with the same refund. A policy change does not alter an already CONFIRMED booking's terms — with a test |
| M5 | Reconciliation returns zero discrepancies after a chaos run |
| M6 | Six invariants pass against the deployed instance, from outside |

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Chaos debugging runs long | M3 slips | M2 is built chaos-off. `X-Paygate-Force` makes each behaviour deterministic instead of waiting for a percentage to fire |
| Out-of-order webhook attempts an illegal transition | Worker 500s | Treat `ATR01` as already-applied: mark processed, do not error |
| Render free tier sleeps | Worker and embedded Paygate stop; a deployed INV-4 test can fail | Document in README. `verify:deployed` warms the instance first |
| 6,371 stale HELD rows in the local database | Reaper expires them all on first run | Expected. Batch of 100 per tick. Reseed before any demo |
| Benchmark numbers go stale | LOAD_TEST.md misreports | Re-run at M6 |
| Scope creep into Tier 2 | Tier 1 left incomplete | Admin console, reports and CI are untouched before M6 |

---

## Definition of done, per item

- [ ] A test against the risky logic, not a trivial getter
- [ ] No `UPDATE bookings SET status` outside the state machine trigger
- [ ] Database errors translated at the repository boundary — never a 500
- [ ] Every repository method takes `AuthScope`
- [ ] New defects logged to `AI_LOG.md` and `README.md` Known Issues, not fixed unasked
- [ ] Honest commit message, and no commit without asking

---

## Checkpoints

| After | What to look at |
|---|---|
| M2 | The first real lifecycle runs. Stop and check whether the design survived contact |
| M3 | The one the brief says it will test directly: INV-4 |
| M4 | Shippable. Stopping here leaves Tier 1 at roughly 85%, with a working payment path rather than a half-built one |
| M6 | Submission-ready |

The ordering exists so that every milestone leaves the repository deployable. Stopping
at M3 gives a complete payment path without cancellation, not an unfinished one.
