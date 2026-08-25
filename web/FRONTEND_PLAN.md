# Atrium Frontend — Build Plan

The existing `web/` is a request console: a form, a table, a response log. It
proves the API answers. It does not look like a product, it has no navigation,
no roles, and no settings. It is being replaced.

This plan is what to build, in what order, against an API that is already
complete — 35 routes, every one of them scoped server-side.

---

## 1. The API surface, by who uses it

Authorisation is enforced in SQL predicates on the server. **The frontend never
decides what a user may see — it decides what to draw.** A menu item hidden from
a customer is a UX decision; the 404 they get if they type the URL is the
security boundary.

### Everyone (authenticated)

| Endpoint | Used by |
| --- | --- |
| `POST /auth/login` | login page |
| `POST /auth/register` | signup page (creates a CUSTOMER) |
| `GET /auth/me` | app shell — decides the sidebar |
| `PATCH /auth/password` | settings |
| `GET /venues` | city picker; console venue switcher |
| `GET /venues/:id` | venue header |
| `GET /venues/:id/policy` | cancellation terms at checkout |
| `GET /bookings` | bookings list (scoped: own / venue's / all) |
| `GET /bookings/:id` | booking detail — line items, payment, refund, terms |
| `GET /bookings/:id/audit` | booking timeline |
| `POST /bookings/:id/cancel` | cancel |
| `GET /health` | ops page |

### Customer path

| Endpoint | Used by |
| --- | --- |
| `GET /rooms` | search with city, capacity, price, amenities, availability window |
| `GET /rooms/facets` | populates the filter controls |
| `GET /rooms/:id` | room detail |
| `GET /rooms/:id/availability` | calendar — busy intervals + operating hours |
| `GET /rooms/:id/equipment` | equipment picker |
| `POST /bookings/hold` | take the slot |
| `POST /bookings/:id/checkout` | re-issue the hold for the 10 minute window |
| `POST /bookings/:id/pay` | 202 accepted, then poll |

### Venue console (`VENUE_STAFF` reads, `VENUE_ADMIN` writes)

| Endpoint | Role | Used by |
| --- | --- | --- |
| `GET /venues/:id/rooms` | staff | room table, archived included |
| `POST /venues/:id/rooms` | admin | add room |
| `PATCH /rooms/:id` | admin | edit, reprice, archive |
| `GET /venues/:id/equipment` | staff | equipment table, buffer included |
| `POST /venues/:id/equipment` | admin | add equipment |
| `PATCH /equipment/:id` | admin | edit, buffer, archive |
| `PATCH /venues/:id` | admin | name, city, timezone, operating hours |
| `PATCH /venues/:id/policy` | admin | publish refund tiers |
| `GET /venues/:id/staff` | admin | staff table |
| `POST /venues/:id/staff` | admin | invite staff |
| `PATCH /venues/:id/staff/:userId` | admin | change role, deactivate |
| `GET /reports/revenue` | staff | revenue and utilisation |
| `GET /reports/reconciliation` | staff | INV-5 |

### Platform admin

Everything above, unscoped, plus `POST /venues`.

### Not called by the frontend

`POST /webhooks/paygate` is the provider's. The mock provider's own endpoints
(`/paygate/*`) are called by the worker, never by a browser.

---

## 2. Stack

Already in `web/package.json`: Next 16 (App Router), React 19, Tailwind v4,
TypeScript. Keep all four. What to add:

| Concern | Choice | Rejected | Why |
| --- | --- | --- | --- |
| Components | **shadcn/ui** (Radix + Tailwind v4) | MUI, Mantine | Components are copied into the repo, so they are editable and add no runtime dependency. Radix gives keyboard and screen-reader behaviour that is expensive to write. Tailwind v4 is already configured. |
| Server state | **TanStack Query v5** | `useEffect` + fetch | The payment path polls, the console invalidates after every write, and the hold path retries. Query does caching, polling, invalidation and mutation state; hand-rolling that is where the bugs go. |
| Forms | **react-hook-form + zod** | uncontrolled forms | The API validates with zod. The same schemas can be mirrored client-side, so the shape is stated once and the two cannot drift. |
| Tables | **TanStack Table v8** | hand-written `<table>` | Six console tables need sorting and pagination. Headless, so shadcn's `<Table>` stays the markup. |
| Dates | **date-fns** + **react-day-picker** | dayjs, luxon | react-day-picker is what shadcn's `Calendar` wraps. Venues are in three timezones — every displayed time is formatted through the venue's IANA zone, never the browser's. |
| Charts | **Recharts** | Chart.js | The revenue report needs one bar chart and one utilisation gauge. Recharts is what shadcn's chart block uses. |
| Icons | **lucide-react** | — | shadcn default. |
| Toasts | **sonner** | — | shadcn default. Every 409 becomes a toast that names what happened. |

No global state library. Server state is TanStack Query; filter state is URL
search params, so a search is shareable and the back button works.

```bash
cd web
npx shadcn@latest init
npx shadcn@latest add button card input label select checkbox badge table dialog sheet dropdown-menu form calendar popover tabs skeleton separator avatar alert sonner tooltip switch slider
npm i @tanstack/react-query @tanstack/react-table react-hook-form @hookform/resolvers zod date-fns recharts lucide-react sonner
```

---

## 3. Route map

App Router, three groups. `(auth)` is unauthenticated and has no shell.
`(app)` carries the sidebar. Nothing is server-rendered against the API —
the token lives in the browser, so pages are client components fed by Query.

```
app/
  (auth)/
    login/page.tsx
    register/page.tsx
  (app)/
    layout.tsx                      shell: sidebar + topbar + <AuthGate>
    page.tsx                        role-aware redirect
    search/page.tsx                 room search
    rooms/[id]/page.tsx             room detail, calendar, hold
    checkout/[bookingId]/page.tsx   countdown, terms, pay
    bookings/page.tsx               bookings list
    bookings/[id]/page.tsx          booking detail + timeline
    settings/page.tsx               profile, password
    console/
      page.tsx                      venue dashboard
      bookings/page.tsx             venue bookings, staff actions
      rooms/page.tsx                room table + editor
      equipment/page.tsx            equipment table + editor
      policy/page.tsx               refund tier editor
      staff/page.tsx                staff table
      settings/page.tsx             venue name, city, timezone, hours
      reports/page.tsx              revenue + utilisation
      reconciliation/page.tsx       INV-5
    admin/
      venues/page.tsx               all venues, create
      venues/[id]/page.tsx          drills into the console for that venue
      ops/page.tsx                  health, replica, migrations
  layout.tsx                        providers: Query, theme, Toaster
```

`/` redirects by role: `CUSTOMER → /search`, `VENUE_STAFF` and `VENUE_ADMIN →
/console`, `PLATFORM_ADMIN → /admin/venues`.

---

## 4. Navigation

One `<Sidebar>` fed by a role table. The four roles are the product; the sidebar
is where that is visible.

| Item | CUSTOMER | VENUE_STAFF | VENUE_ADMIN | PLATFORM_ADMIN |
| --- | :-: | :-: | :-: | :-: |
| Find a room | ● | | | ● |
| My bookings | ● | | | |
| Dashboard | | ● | ● | |
| Bookings | | ● | ● | ● |
| Rooms | | ● read | ● | ● |
| Equipment | | ● read | ● | ● |
| Refund policy | | | ● | ● |
| Staff | | | ● | ● |
| Reports | | ● | ● | ● |
| Reconciliation | | ● | ● | ● |
| Venue settings | | | ● | ● |
| All venues | | | | ● |
| Ops | | | | ● |
| Settings | ● | ● | ● | ● |

Staff see Rooms and Equipment because they manage bookings against them, and the
API lets them read those lists. Every write control on those pages is hidden for
staff — and refused with 403 if they reach it anyway.

The topbar carries: venue name (from `GET /auth/me`), a venue switcher for
platform admins, the theme toggle, and the account menu.

---

## 5. Components

### From shadcn, unmodified
`Button` `Card` `Input` `Label` `Select` `Checkbox` `Badge` `Table` `Dialog`
`Sheet` `DropdownMenu` `Form` `Calendar` `Popover` `Tabs` `Skeleton`
`Separator` `Avatar` `Alert` `Tooltip` `Switch` `Slider` `Sonner`

### App components

**Shell** — `AppSidebar`, `Topbar`, `AuthGate` (redirects to `/login` on 401),
`RoleGate` (hides a control; never the only check), `VenueSwitcher`,
`ThemeToggle`.

**Money and time** — `Money` (minor units → `PKR 1,800.00`; the API is integers
throughout and the frontend must never do floating-point arithmetic on them),
`VenueTime` (formats an instant in the venue's IANA zone with the zone shown),
`Countdown` (hold expiry, to the second), `StatusBadge` (one colour per booking
state, one per payment state).

**Search** — `SearchFilters` (city select, capacity, price ceiling, amenity
multi-select, date-range — all bound to URL search params), `RoomCard`,
`RoomGrid`, `EmptyState`.

**Booking** — `AvailabilityCalendar` (week view; busy intervals shaded,
closed hours hatched), `SlotPicker` (derives free slots — see §7),
`EquipmentPicker` (quantity steppers, live subtotal), `PriceBreakdown`
(room hours × rate, each equipment line, total), `HoldSummary`.

**Checkout** — `CheckoutTimer`, `RefundTermsTable` (the tiers from the
booking's own policy version), `PayButton`, `PaymentStatus` (polls).

**Booking detail** — `BookingHeader`, `LineItemTable`, `PaymentPanel`,
`RefundPanel`, `AuditTimeline` (vertical, system actors marked distinctly from
human ones), `CancelDialog` (shows the refund due before confirming).

**Console** — `DataTable` (TanStack Table + shadcn `Table`, with a toolbar,
column sorting and pagination), `RoomForm`, `EquipmentForm` (buffer as a slider
capped at 10%), `PolicyTierEditor` (rows of hours/room %/equipment %, refuses to
save without a band at 0), `OperatingHoursEditor` (seven days, add/remove
windows), `StaffTable`, `InviteStaffDialog`, `ArchiveDialog` (says "archive",
not "delete", and says why).

**Reports** — `RevenueSummary` (gross, refunded, net), `RevenueByRoomChart`,
`UtilisationGauge`, `DateRangePicker`, `ReconciliationTable` (grouped by kind,
green when the count is zero — that zero is the headline).

**Ops** — `HealthCard` (status, replica id, migrations applied).

---

## 6. API service layer

```
web/lib/api/
  client.ts        fetch wrapper: base URL, bearer token, x-correlation-id,
                   ApiError { status, code, message, correlationId }
  types.ts         response shapes, mirrored from src/domain/types.ts
  auth.ts          login, register, me, changePassword
  rooms.ts         search, facets, get, availability, equipment, update
  bookings.ts      list, get, audit, hold, checkout, pay, cancel
  venues.ts        list, get, create, update, rooms, addRoom, equipment,
                   addEquipment, staff, addStaff, updateStaff, policy,
                   publishPolicy
  equipment.ts     update
  reports.ts       reconciliation, revenue
  health.ts        check
web/lib/
  auth-context.tsx token in localStorage, decoded claims, logout on 401
  query-keys.ts    one factory, so invalidation after a write is exact
  format.ts        money, dates, durations
```

`client.ts` is the only place `fetch` appears. It:

- attaches `Authorization: Bearer <token>` and a generated `x-correlation-id`
  (the API accepts an inbound one and echoes it on every response, so a browser
  error can be traced to a server log line — say so in the error toast);
- parses the API's error shape `{ error, message, correlationId }` into an
  `ApiError` and throws it, so Query's `error` is always typed;
- on 401, clears the token and sends the user to `/login`.

---

## 7. The four parts that are actually hard

**Free slots.** `GET /rooms/:id/availability` returns *busy* intervals and the
venue's operating hours, not free slots — deliberately, because "free" depends
on how long the caller wants. `SlotPicker` derives them: walk the operating
window for each day in 30 minute steps, drop any start where
`[start, start + duration + 15min)` intersects a busy range, and drop anything
outside the 1 hour to 90 day advance window. The 15 minutes is the turnaround
the database already bakes into `reserved_range` — the client must add it too,
or it will offer slots the server will reject with 409.

**The checkout clock.** A hold lives 8 minutes. `POST /bookings/:id/checkout`
re-issues it for 10 minutes and returns `expiresAt`. The checkout page calls it
on mount, counts down from the returned instant, warns at 60 seconds, and on
zero stops offering to pay and offers to take the slot again. Never count down
from a locally computed deadline — the server's `expiresAt` is the only one that
matters.

**Payment is asynchronous.** `POST /bookings/:id/pay` returns **202** with a
payment id; the charge is submitted by a worker and confirmed by a webhook. So
after 202, poll `GET /bookings/:id` every 2 seconds until `status` leaves
`PENDING_PAYMENT`, with a 60 second ceiling. Outcomes to draw: `CONFIRMED`
(done), `FAILED` (declined, offer to retry), `EXPIRED` **with a refund** (INV-4 —
the capture landed after the hold died; tell the user the money is coming back),
and timeout (still pending, tell them plainly and link to the booking). A
**200** instead of 202 means a charge already existed — treat it as success, not
an error, and go straight to polling.

**Every 409 has a meaning.** The API returns a code, and the UI must say
something different for each:

| Code | What the user is told |
| --- | --- |
| `ROOM_UNAVAILABLE` | someone took that slot first — refresh availability |
| `EQUIPMENT_UNAVAILABLE` | the message names how many units are free |
| `NOT_HELD` / `NOT_PAYABLE` | the booking moved on — reload it |
| `HOLD_EXPIRED` | the hold ran out — take the slot again |
| `ALREADY_CHARGED` | already paying — go to the booking |
| `ILLEGAL_TRANSITION` | the action no longer applies |
| `CONTENTION` | busy slot — retry (retry once automatically) |
| `UNITS_COMMITTED` | console: cannot cut units below what is booked |
| `OUTSIDE_OPERATING_HOURS` | the venue is closed then |

A 409 is never an error dialog. It is a toast plus a refetch of whatever went
stale.

---

## 8. Design

Dark by default with a light toggle, both defined as CSS variables so the whole
palette is two token sets. Neutral slate ground, one accent used only for
primary actions and the selected slot. Generous whitespace, cards with hairline
borders rather than shadows, `text-sm` body, tabular numerals for money and
times. Booking states get their own colours and keep them everywhere: HELD amber,
PENDING_PAYMENT blue, CONFIRMED green, COMPLETED slate, EXPIRED/FAILED/CANCELLED
grey, REFUNDED violet.

Every list has three states drawn, not two: loading (`Skeleton`, never a
spinner), empty (says what to do next), and error (says what failed and shows
the correlation id).

Mobile: the sidebar collapses into a `Sheet`. The search and booking pages are
usable on a phone; the console tables scroll horizontally rather than reflowing.

---

## 9. Build order

Each phase leaves something demonstrable.

| Phase | What | Proves |
| --- | --- | --- |
| 1 | shadcn init, providers, `client.ts`, auth context, login, register, shell + sidebar, settings | A user of each role can log in and sees their own navigation |
| 2 | Search, filters from facets, room detail, availability calendar, equipment picker, hold | The customer path to a HELD booking |
| 3 | Checkout timer, terms, pay, polling, booking detail, audit timeline, cancel with refund quote | The whole lifecycle, including INV-4 |
| 4 | Console: dashboard, bookings, room and equipment tables and forms, archive | Tier 2's venue console |
| 5 | Policy editor, venue settings, staff | The rest of a venue admin's control |
| 6 | Revenue report, reconciliation, ops | The proof surface, in a browser |
| 7 | Empty and error states, mobile, keyboard pass, deploy to Vercel | Shippable |

Phases 1 to 3 are the demo. If time runs out, 4 to 6 are what gets cut, and the
cut goes in `TIMELINE.md` with the reason.

---

## 10. Deployment

Vercel Hobby, one project, root `web/`. `NEXT_PUBLIC_API_URL` points at the
Render instance. The API's `CORS_ORIGINS` must list the Vercel domain — it fails
closed, so an unset variable means every browser request is blocked, and that is
the first thing to check if the deployed frontend cannot talk to the deployed
API.

Render sleeps after 15 minutes. The first request after a sleep takes 30 to 60
seconds, so the app shell shows a "waking the server" state rather than an error
when the first `GET /auth/me` is slow.
