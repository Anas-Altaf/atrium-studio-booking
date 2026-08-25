/**
 * The local benchmark, against --profile=full behind the three replicas.
 *
 *   docker compose --profile bench run --rm k6
 *
 * Runs inside compose on the same network as the load balancer, so there is
 * nothing to install: the reviewer already needs Docker for `docker compose up`.
 *
 * The brief's latency targets are thresholds here, not a table to compare
 * against by eye. k6 exits non-zero when one is missed, so "did it hit 300ms"
 * has an answer that does not depend on who is reading.
 *
 * Phases run one after another with startTime offsets rather than together.
 * Three endpoints contending for one Postgres would measure the contention,
 * not the endpoints.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// A 409 on a hold is the system working: the slot was taken. Left as the
// default, k6 counts every 4xx as a failed request and the error rate for the
// hold phase would report correct behaviour as failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

const BASE = __ENV.BASE_URL || 'http://lb:80';
const VUS = Number(__ENV.VUS || 20);
const PHASE = __ENV.PHASE_DURATION || '15s';

// Karachi is UTC+5 with no DST, so 07:00Z is 12:00 local all year -- inside
// every window in the seeded operating hours, including Sunday's shorter one.
// Holds land 10 to 80 days out: past the one hour minimum, short of the 90 day
// ceiling.
// 06:00Z to 12:00Z is 11:00 to 17:00 in Karachi -- inside every window in the
// seeded operating hours, Sunday's shorter one included. Seven bands over 70
// days over 100 rooms is a 49,000 slot pool, so a second run can be given an
// offset instead of a reseed.
const HOLD_BANDS_UTC = [6, 7, 8, 9, 10, 11, 12];
const FIRST_DAY = 10;
const LAST_DAY = 80;

// Slots already consumed by an earlier run against this same seeded data.
const HOLD_OFFSET = Number(__ENV.HOLD_OFFSET || 0);

const HOLD_ITERATIONS = Number(__ENV.HOLD_ITERATIONS || 4000);

const conflicts = new Counter('hold_conflicts');
const rejected = new Counter('hold_rejected');

// The target is for a hold that is placed. A 409 is a different path -- the
// constraint rejects it before most of the work happens -- so averaging the two
// together would report a number that improves as the system does less.
//
// Two metrics for one event: k6 supports no count aggregation on a trend, and
// the percentile means nothing without knowing how many samples it came from.
const created = new Trend('hold_created_duration', true);
const createdCount = new Counter('hold_created');

export const options = {
  // p99 is in the brief's results table and is not in k6's default set.
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg'],
  scenarios: {
    search: {
      executor: 'constant-vus', vus: VUS, duration: PHASE,
      exec: 'search', startTime: '0s',
    },
    availability: {
      executor: 'constant-vus', vus: VUS, duration: PHASE,
      exec: 'availability', startTime: '20s',
    },
    // Fixed iteration count, not a duration: every iteration writes a real
    // booking, so the row count this adds should be a number I can state.
    hold: {
      executor: 'shared-iterations', vus: VUS,
      iterations: HOLD_ITERATIONS, maxDuration: '180s',
      exec: 'hold', startTime: '40s',
    },
    // After the hold phase's maxDuration, not overlapping it: this scenario
    // reads the same bookings table the hold phase is writing to.
    revenue: {
      executor: 'constant-vus', vus: VUS, duration: PHASE,
      exec: 'revenue', startTime: '225s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:search}': ['p(95)<500'],
    'http_req_duration{scenario:availability}': ['p(95)<300'],
    'http_req_duration{scenario:revenue}': ['p(95)<800'],
    'http_req_failed{scenario:search}': ['rate<0.01'],
    'http_req_failed{scenario:availability}': ['rate<0.01'],
    'http_req_failed{scenario:hold}': ['rate<0.01'],
    'http_req_failed{scenario:revenue}': ['rate<0.01'],
    hold_created_duration: ['p(95)<250'],
    // Enough holds have to actually be placed for that percentile to mean
    // anything. If the seeded calendar has taken most of the slot pool, this
    // fails rather than reporting a p95 over a handful of samples.
    hold_created: ['count>500'],
    // Anything that is neither 201 nor 409 is the benchmark asking for
    // something the API refuses -- bad slot arithmetic, not a measurement.
    hold_rejected: ['count<1'],
    // Declared so the sub-metric exists in the summary; not a pass condition.
    'http_reqs{scenario:hold}': ['count>0'],
  },
};

export function setup() {
  const token = login('customer@atrium.test', 'atrium123');
  const res = http.get(`${BASE}/rooms?city=Karachi&limit=100`, auth(token));
  if (res.status !== 200) fail(`room lookup failed: ${res.status} ${res.body}`);

  const rooms = res.json().map((r) => r.id);
  if (rooms.length === 0) fail('no Karachi rooms: seed --profile=full first');

  // The report is for venue staff, so it needs a token with reach. The busiest
  // venue, not an arbitrary one: the target is meaningless against a venue with
  // no takings to add up.
  const platform = login('platform@atrium.test', 'atrium123');
  const venues = http.get(`${BASE}/venues?city=Karachi`, auth(platform));
  if (venues.status !== 200) fail(`venue lookup failed: ${venues.status} ${venues.body}`);
  const venueId = venues.json()
    .sort((a, b) => b.room_count - a.room_count)[0].id;

  const capacity = rooms.length * (LAST_DAY - FIRST_DAY) * HOLD_BANDS_UTC.length;
  if (capacity < HOLD_ITERATIONS + HOLD_OFFSET) {
    fail(`slot pool holds ${capacity}, hold phase wants `
       + `${HOLD_ITERATIONS} from offset ${HOLD_OFFSET}`);
  }

  return { token, platform, venueId, rooms, midnight: utcMidnight() };
}

/**
 * Every filter the brief names, together: city, minimum capacity, amenity set,
 * price ceiling and an availability window. The window is the expensive half —
 * it is an anti-join against 250,000 bookings — and leaving it off would measure
 * an easier query than the one the target is set for.
 */
export function search(data) {
  const { from, to } = week(data.midnight);
  const res = http.get(
    `${BASE}/rooms?city=Karachi&minCapacity=10&maxPriceMinor=1200000&amenities=wifi`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`,
    auth(data.token),
  );
  check(res, { 'search 200': (r) => r.status === 200 });
}

/** One room over seven days, through the same GiST index the constraint uses. */
export function availability(data) {
  const { from, to } = week(data.midnight);
  const roomId = data.rooms[exec.scenario.iterationInTest % data.rooms.length];
  const res = http.get(
    `${BASE}/rooms/${roomId}/availability`
    + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    auth(data.token),
  );
  check(res, { 'availability 200': (r) => r.status === 200 });
}

const week = (midnight) => ({
  from: new Date(midnight + FIRST_DAY * 86400000).toISOString(),
  to: new Date(midnight + (FIRST_DAY + 7) * 86400000).toISOString(),
});

/** The brief's fourth target: one venue's books over 30 days. */
export function revenue(data) {
  const to = new Date(data.midnight).toISOString();
  const from = new Date(data.midnight - 30 * 86400000).toISOString();
  const res = http.get(
    `${BASE}/reports/revenue?venueId=${data.venueId}`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    auth(data.platform),
  );
  check(res, { 'revenue 200': (r) => r.status === 200 });
}

/**
 * One slot per (room, day) pair, indexed by the scenario's global iteration
 * number, so two VUs never ask for the same one. Contention is what the
 * concurrency proof measures; this is measuring a hold that wins.
 */
export function hold(data) {
  const i = exec.scenario.iterationInTest + HOLD_OFFSET;
  const perBand = data.rooms.length * (LAST_DAY - FIRST_DAY);
  const band = HOLD_BANDS_UTC[Math.floor(i / perBand) % HOLD_BANDS_UTC.length];
  const j = i % perBand;

  const roomId = data.rooms[j % data.rooms.length];
  const day = FIRST_DAY + Math.floor(j / data.rooms.length);
  const startAt = new Date(data.midnight + day * 86400000 + band * 3600000);
  const endAt = new Date(startAt.getTime() + 3600000);

  const res = http.post(
    `${BASE}/bookings/hold`,
    JSON.stringify({
      roomId,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      equipment: [],
    }),
    auth(data.token, { 'content-type': 'application/json' }),
  );

  if (res.status === 201) { created.add(res.timings.duration); createdCount.add(1); }
  else if (res.status === 409) conflicts.add(1);
  else rejected.add(1);

  check(res, { 'hold 201 or 409': (r) => r.status === 201 || r.status === 409 });
}

function login(email, password) {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 200) fail(`login failed: ${res.status} ${res.body}`);
  return res.json().token;
}

const auth = (token, extra) => ({
  headers: Object.assign({ authorization: `Bearer ${token}` }, extra || {}),
});

function utcMidnight() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** The table that goes into LOAD_TEST.md, generated rather than transcribed. */
export function handleSummary(data) {
  const phases = [
    ['Room availability, 7 day range', 'availability', 300],
    ['Cross-venue search, combined filters', 'search', 500],
    ['Create hold', 'hold', 250],
    ['Venue revenue report, 30 days', 'revenue', 800],
  ];

  const rows = phases.map(([label, scenario, target]) => {
    // The hold row reports only the holds that were placed; see the Trend above.
    const d = scenario === 'hold'
      ? data.metrics.hold_created_duration
      : data.metrics[`http_req_duration{scenario:${scenario}}`];
    const f = data.metrics[`http_req_failed{scenario:${scenario}}`];
    if (!d) return `| ${label} | < ${target} ms | did not run | | | | | |`;
    const v = d.values;
    return `| ${label} | < ${target} ms | ${ms(v.med)} | **${ms(v['p(95)'])}** | `
      + `${ms(v['p(99)'])} | ${ms(v.max)} | ${pct(f && f.values.rate)} | `
      + `${v['p(95)'] < target ? 'yes' : 'NO'} |`;
  });

  const md = [
    '| Endpoint | Target p95 | p50 | p95 | p99 | max | Error rate | Met |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Holds attempted: ${count(data, 'http_reqs{scenario:hold}')}`
    + ` · placed: ${count(data, 'hold_created')}`
    + ` · 409 conflicts: ${count(data, 'hold_conflicts')}`
    + ` · 4xx/5xx other than 409: ${count(data, 'hold_rejected')}`,
    '',
  ].join('\n');

  return {
    stdout: `\n${md}\n`,
    'summary.json': JSON.stringify(data, null, 2),
    'summary.md': md,
  };
}

const ms = (n) => (n === undefined ? '-' : `${n.toFixed(1)}`);
const pct = (r) => (r === undefined ? '-' : `${(r * 100).toFixed(2)}%`);
const count = (data, name) => {
  const m = data.metrics[name];
  return m ? m.values.count : 0;
};
