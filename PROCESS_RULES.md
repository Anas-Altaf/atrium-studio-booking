# PROCESS RULES — Project Atrium Assessment

Non-code obligations only. Everything here is graded or gates a grade.
This file is a working aid, not a deliverable. Delete or gitignore before submission if desired.

---

## PART A — HARD CAPS (fail conditions)

These cap the **total score** regardless of how good everything else is. Check these three before anything else.

| # | Condition | Meaning |
|---|---|---|
| CAP-1 | Concurrency proof oversells or double books | The 200-request test must show exactly 1 room booking, ≤3 equipment units |
| CAP-2 | System not deployed and reachable | Frontend AND API both live, seeded at demo profile |
| CAP-3 | Authorisation bypassable across venues | Venue A admin must never read/write Venue B data, including by direct UUID |

**Rule:** Any hour spent on Tier 3 before all three of these are green is a wasted hour.

---

## PART B — TIMING RULES (clock-gated, cannot be recovered later)

| Deadline | Obligation | Consequence if missed |
|---|---|---|
| ~~**Hour 0–3**~~ | ~~Email ONE batch of clarifying questions~~ | **CLOSED — deliberately not sent.** Every remaining ambiguity is self-resolved and documented in `ARCHITECTURE.md` §6 (A1–A8). Reasoning in `TIMELINE.md` |
| ~~**Hour 0–4**~~ | ~~Commit AND push a first draft of the **concurrency strategy** section of `ARCHITECTURE.md`~~ | **DONE** — commit `d82c1ac`, 2026-08-22 16:02 PKT, before any hold endpoint existed |
| **Hour 24** | Submission email sent | Anything committed after the deadline is not reviewed |
| **+48h** | 30-minute live defense call | No notes permitted |

### The design-before-code rule in detail
The 4-hour draft must **name the mechanism** for rooms and the mechanism for equipment, and say why each holds. It does not need to be long.

If the final implementation contradicts that early draft:
- **DO NOT** quietly rewrite the draft.
- Leave both versions in the document.
- Add a note: what changed, and why you changed your mind.

Discovering mid-build that the first approach was wrong is explicitly called "good engineering" in the brief. Hiding it is the failure.

---

## PART C — HONESTY RULES

These are stated as scoring signals, not suggestions.

1. **Broken things go in the README.** A known, documented bug costs almost nothing. An undocumented one found in review costs a great deal.
2. **Unbuilt things get written reasoning.** "How I would have built it" earns partial credit. Silence earns none.
3. **Zero AI mistakes = disqualifying.** The brief states that reporting no agent errors means you either did not review the output or are not being straight. Both are disqualifying signals.
4. **In the live defense, "I don't know" is cheap.** A confident wrong explanation costs far more.
5. **Real commit history.** A single squashed commit at the end scores zero on process. They want to see the shape of the day.

---

## PART D — FILES TO MAINTAIN

### D.1 The six required deliverable files

| File | Cadence | What goes in |
|---|---|---|
| `ARCHITECTURE.md` | Draft by hour 4, then continuously | 8 mandatory sections — see D.2 |
| `DECISIONS.md` | At each decision point | 8–15 entries. Each: the choice, one alternative rejected, the trade-off accepted. Three lines each is plenty |
| `AI_LOG.md` | The moment the agent errs | What was delegated, where the agent was wrong or naive, what you overrode and why |
| `TIMELINE.md` | Hourly, as you go | Rough hour-by-hour of the window, what you cut, why you cut it |
| `LOAD_TEST.md` | After benchmarking | Script + results table + EXPLAIN output — see D.3 |
| `README.md` | Last, but not rushed | Setup + known issues — see D.4 |

### D.2 `ARCHITECTURE.md` — the most important document

Eight mandatory sections. Missing one is a visible gap:

1. **Entity relationship diagram.** Any tool. A legible whiteboard photo is explicitly acceptable.
2. **Booking state machine diagram**, including *every failure edge* — not just the happy path.
3. **Concurrency strategy.** Name the mechanism for rooms. Name the mechanism for equipment. Explain why each holds. Explain what happens across three instances behind a load balancer.
4. **Payment integrity model.** How exactly-once *effect* is achieved over Paygate's at-least-once, out-of-order channel.
5. **Indexing and query strategy**, with EXPLAIN evidence.
6. **Assumptions.** Every ambiguity resolved alone, and what was decided.
7. **What breaks at 100x.** Name the first three things that fall over at 25 million bookings, and what you would do about each.
8. **What I would do with two more weeks**, in priority order.

Also required inside this file: the **pasted output of the 200-request concurrency proof**.

### D.3 `LOAD_TEST.md` — reproducibility is the point

Must contain:
- The k6 / Artillery / equivalent script itself
- Results table: **p50, p95, p99, error rate** for each endpoint
- The **machine spec** it was run on
- **`EXPLAIN ANALYZE` for the availability query, before and after** indexing work, with a sentence on what changed

They will re-run the script from the repo. Numbers must be reproducible, not merely reported.

Targets (p95, local, `--profile=full`):

| Endpoint | Target |
|---|---|
| Room availability, 7-day range | < 300 ms |
| Cross-venue search, combined filters | < 500 ms |
| Create hold | < 250 ms |
| Venue revenue report, 30 days | < 800 ms |

If a target is missed: document what was measured, what was tried, and what you would do next. The brief says that is worth most of the marks.

### D.4 `README.md`

- A working `docker compose up` that stands up **three API replicas behind a load balancer** and gets a reviewer running in **under 5 minutes**
- A blunt **"Known Issues and What I Did Not Finish"** section

### D.5 `DECISIONS.md` format

Keep entries short. Target 8–15 total.

```
### <N>. <The decision>
**Chose:** ...
**Rejected:** ...
**Trade-off accepted:** ...
```

Stack choice must be justified against at least one rejected alternative. "It is what I know" is acceptable *if* stated honestly and paired with what it costs here.

---

## PART E — NON-FILE DELIVERABLES

| Artifact | Requirement |
|---|---|
| **Git repository** | Public or shared. Real commit history showing the shape of the day |
| **Deployed URLs** | Frontend and API both live, seeded to `demo` volume |
| **Test logins** | Five: one per role (4) **plus a second venue admin at a different venue** — so tenant isolation can be tested |
| **Walkthrough** | 5-minute screen recording. Show the concurrency test passing, and walk one booking through the full lifecycle. **No slides** |
| **Submission email** | To `careers@adept-techsolutions.com`, subject `Atrium Assessment: [Your Name]`, containing repo link + both deployed URLs + test credentials + recording link |

---

## PART F — TEST OBLIGATIONS (named, not optional)

Four test artifacts are explicitly required:

1. **The 200-request concurrency proof** — clearly named, documented in README, run against three replicas behind a load balancer. Same room, same one-hour slot, plus an EquipmentType with exactly 3 units. Asserts: exactly one room booking succeeds, at most 3 equipment units reserved, every other request gets a clean **409** (not a 500, not a duplicate success).
2. **Cross-venue authorisation negative test** — VENUE_ADMIN of Venue A gets 403 or 404 and never data when requesting a booking, room, or report of Venue B. **Must include the case of guessing a valid Venue B UUID directly.**
3. **Unit tests over the state machine and the refund calculator.**
4. **One end-to-end happy path.**

---

## PART G — HOSTING CONSTRAINTS

**Zero cost is a hard requirement.** If a credit card is needed, the choice is wrong.

**Allowed (verified free in the brief):**
- Backend — Render Hobby, Cloudflare Workers, Koyeb, Vercel functions
- Database — Neon free (0.5 GB), Supabase free (500 MB), Render free Postgres (1 GB, 30-day expiry)
- Frontend — Vercel Hobby, Netlify, Cloudflare Pages, Render static sites

**Explicitly banned:** Railway, Fly.io. Neither has a free tier any more.

**Note:** Render Hobby sleeps after 15 min idle with a 30–60s cold start. Mention this in the README so a reviewer hitting a slow first request does not read it as a fault.

---

## PART H — SCOPE ORDER RULE

> Do not start anything in a lower tier until the tier above it is correct, tested and deployed.

**Tier 1 (MUST)** — auth with four roles + enforced venue-scoped authorisation · availability query + cross-venue search · hold/pay/confirm with equipment line items · all six invariants with the 200-request proof passing · Paygate to spec with chaos on · cancellation with data-driven refund policy · append-only audit trail · seed script both profiles, deployed on demo, benchmarked locally on full

**Tier 2 (SHOULD)** — venue admin console · reconciliation report (INV-5) · revenue and utilisation report with date range · structured logging with a correlation ID that survives into the webhook path · health endpoint that actually checks dependencies · CI on every push

**Tier 3 (COULD)** — realtime heatmap + drag-to-select calendar · natural language booking · recurring bookings · waitlist with auto-promotion · notifications

**The trap, stated openly in the brief:** Tier 3 is more fun and more visible in a demo than a correct locking strategy. That was deliberate. A beautiful real-time calendar with a race condition in the hold path scores *below* a plain submission with no Tier 3 and all of Tier 1 correct.

**Obligation:** state in `TIMELINE.md` that this choice was made consciously.

---

## PART I — SCORING WEIGHTS (for allocating the day)

| Dimension | Weight | Top band earned by |
|---|---|---|
| System design and architecture | **35%** | Defensible concurrency model, sound data model, clear boundaries, honest trade-offs, real 100x analysis |
| Code quality, structure and testing | **27%** | Readable, consistent, layered. Tests targeting risky logic, not trivial getters |
| Completeness and prioritisation | **22%** | Tier 1 fully correct, sensible cuts, cuts explained. Not raw feature count |
| DevOps and observability | **16%** | Live, reproducible, CI green, useful logs, meaningful health check |

**Reading:** 35% is a *writing* task. Roughly 57% (35 + 22) is won by documentation and judgment rather than by shipping more features.

---

## PART J — WORKING CHECKLIST

**Hour 0–4**
- [ ] Read brief fully; extract every requirement
- [ ] Send the one batch of clarifying questions (before hour 3)
- [ ] Commit + push `ARCHITECTURE.md` concurrency section (before hour 4, before hold endpoint)
- [ ] Start `TIMELINE.md` and `AI_LOG.md` as running logs from the first hour

**Continuously**
- [ ] Log every agent error to `AI_LOG.md` the moment it happens
- [ ] Log every decision to `DECISIONS.md` at the moment of choosing
- [ ] Append to `TIMELINE.md` hourly
- [ ] Commit frequently with honest messages

**Before submitting**
- [ ] All three hard caps verified green
- [ ] `ARCHITECTURE.md` has all 8 sections + pasted concurrency proof output
- [ ] `README.md` "Known Issues" section written bluntly
- [ ] `docker compose up` tested from a clean clone, three replicas confirmed, under 5 minutes
- [ ] Five test logins verified working, including the second-venue admin
- [ ] Both deployed URLs verified live and seeded
- [ ] 5-minute recording shows the concurrency test passing and one full booking lifecycle
- [ ] Submission email with correct subject line

---

## PART K — DEFENSE PREPARATION

30 minutes, within 48 hours of submission:

- **10 min** — Defend two design decisions of *their* choosing, including at least one you cannot have anticipated
- **15 min** — A live change request: a new requirement implemented on the call, agent available, narrating as you go. They are watching how well you navigate your own codebase
- **5 min** — Your questions for them

**No notes permitted.**

**Implication for how to build:** anything you cannot explain from memory is a liability. Prefer a mechanism you fully understand over a cleverer one you copied. This is a second, independent reason to keep the design small.
