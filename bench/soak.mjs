/**
 * The invariants under real chaos, against the running stack.
 *
 *   docker compose up -d --build
 *   node bench/soak.mjs
 *
 * The deterministic tests in tests/chaos.test.ts force one provider behaviour
 * at a time and say which one broke. This says whether they hold together:
 * PAYGATE_CHAOS=on, three replicas, three workers, nobody driving the jobs by
 * hand. A third of the holds are expired mid-flight so INV-4 fires under load
 * rather than in a fixture.
 *
 * Assertions are made against the database, not against what the API said.
 */
import pg from 'pg';

const BASE = process.env.SOAK_URL ?? 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgres://atrium:atrium@localhost:5432/atrium';
const BOOKINGS = Number(process.env.SOAK_BOOKINGS ?? 50);
const EXPIRE_RATE = 0.3;
const SETTLE_TIMEOUT_MS = Number(process.env.SOAK_SETTLE_MS ?? 120_000);

pg.types.setTypeParser(20, (v) => Number(v));
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

const run = `soak-${Date.now()}`;
let serverErrors = 0;

async function main() {
  const token = await login();
  const roomIds = await fixture();

  console.log(`\n${run}: ${BOOKINGS} bookings, chaos as configured on the provider\n`);

  const bookings = await place(token, roomIds);
  console.log(`  held    ${bookings.length}`);

  // Pay first, then expire. The other order refuses the payment outright with
  // HOLD_EXPIRED, which is correct behaviour and not INV-4: that one needs the
  // charge already in flight when the hold runs out.
  await paid(token, bookings);
  console.log(`  paid    ${bookings.length}`);

  const expired = await expireSome(bookings);
  console.log(`  expired mid-flight ${expired}`);

  console.log('\n  waiting for the workers to settle...');
  const settled = await waitForSettlement(bookings);
  console.log(`  ${settled ? 'settled' : 'STILL MOVING after the timeout'}\n`);

  const failures = await check(bookings);
  await report(failures);

  await pool.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

async function login() {
  const res = await call('POST', '/auth/login', {
    email: 'customer@atrium.test', password: 'atrium123',
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.body.token;
}

/** Its own venue and rooms, so the seeded calendar is not in the way. */
async function fixture() {
  const { rows: [venue] } = await pool.query(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Soak ${run}`, JSON.stringify(OPEN_ALL_DAY)],
  );

  const ids = [];
  for (let i = 0; i < 10; i++) {
    const { rows: [room] } = await pool.query(
      `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
       VALUES ($1, $2, 10, 250000, '{}', 'Karachi') RETURNING id`,
      [venue.id, `Soak room ${i}`],
    );
    ids.push(room.id);
  }
  return ids;
}

/** Concurrent, because a queue of one proves nothing about three replicas. */
async function place(token, roomIds) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const attempts = Array.from({ length: BOOKINGS }, (_, i) => {
    const start = new Date(midnight.getTime() + (400 + i * 2) * 3_600_000);
    return call('POST', '/bookings/hold', {
      roomId: roomIds[i % roomIds.length],
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3_600_000).toISOString(),
      equipment: [],
    }, token);
  });

  const results = await Promise.all(attempts);
  return results.filter((r) => r.status === 201).map((r) => r.body.id);
}

/**
 * Moves a third of the holds past their TTL before payment is submitted, so
 * the reaper expires them while the charge is in flight. This is INV-4's
 * scenario, and waiting eight real minutes for it is not a test.
 */
async function expireSome(bookingIds) {
  const victims = bookingIds.filter((_, i) => i % Math.round(1 / EXPIRE_RATE) === 0);
  if (victims.length === 0) return 0;

  await pool.query(
    `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
    [victims],
  );
  return victims.length;
}

async function paid(token, bookingIds) {
  await Promise.all(bookingIds.map((id) => call('POST', `/bookings/${id}/pay`, null, token)));
}

/**
 * Settled means this run's bookings have all reached a resting state.
 *
 * Scoped to the run rather than to the whole database: a shared local database
 * carries debris from earlier test runs — a refund against a charge whose
 * in-process provider has since exited will never settle, and waiting on it
 * would hang every soak that followed.
 */
async function waitForSettlement(bookingIds) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { rows: [work] } = await pool.query(
      `SELECT (SELECT count(*) FROM bookings
               WHERE id = ANY($1::uuid[]) AND status IN ('HELD','PENDING_PAYMENT')) AS moving,
              (SELECT count(*) FROM payments
               WHERE booking_id = ANY($1::uuid[])
                 AND status = 'PENDING' AND charge_id IS NULL) AS charges,
              (SELECT count(*) FROM refunds
               WHERE booking_id = ANY($1::uuid[])
                 AND status = 'PENDING' AND provider_refund_id IS NULL) AS refunds`,
      [bookingIds],
    );
    if (Number(work.moving) + Number(work.charges) + Number(work.refunds) === 0) return true;
    await new Promise((r) => { setTimeout(r, 1_000); });
  }
  return false;
}

async function check(bookingIds) {
  const failures = [];
  const scope = [bookingIds];

  const inv3 = await pool.query(
    `SELECT booking_id, count(*) AS n FROM payments
     WHERE booking_id = ANY($1::uuid[]) AND status IN ('PENDING','CAPTURED')
     GROUP BY booking_id HAVING count(*) > 1`, scope,
  );
  if (inv3.rows.length) {
    failures.push(`INV-3: ${inv3.rows.length} booking(s) hold more than one live charge`);
  }

  // INV-4, both halves: no expired booking was confirmed, and every expired
  // booking whose money was taken has a refund against it.
  const confirmedAfterExpiry = await pool.query(
    `SELECT b.id FROM bookings b
     WHERE b.id = ANY($1::uuid[]) AND b.status = 'CONFIRMED'
       AND EXISTS (SELECT 1 FROM audit_events a
                   WHERE a.booking_id = b.id AND a.to_state = 'EXPIRED')`, scope,
  );
  if (confirmedAfterExpiry.rows.length) {
    failures.push(`INV-4: ${confirmedAfterExpiry.rows.length} booking(s) confirmed after expiring`);
  }

  const capturedNoRefund = await pool.query(
    `SELECT b.id FROM bookings b
     JOIN payments p ON p.booking_id = b.id AND p.status = 'CAPTURED'
     WHERE b.id = ANY($1::uuid[])
       AND b.status IN ('EXPIRED','CANCELLED')
       AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.booking_id = b.id)`, scope,
  );
  if (capturedNoRefund.rows.length) {
    failures.push(
      `INV-4: ${capturedNoRefund.rows.length} unconfirmable booking(s) kept the money`);
  }

  // INV-5: a captured charge maps to exactly one CONFIRMED booking or one refund.
  const stranded = await pool.query(
    `SELECT p.id FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     WHERE p.booking_id = ANY($1::uuid[]) AND p.status = 'CAPTURED'
       AND b.status <> 'CONFIRMED'
       AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.booking_id = p.booking_id)`, scope,
  );
  if (stranded.rows.length) {
    failures.push(`INV-5: ${stranded.rows.length} captured charge(s) map to neither`);
  }

  const stuck = await pool.query(
    `SELECT id, status FROM bookings
     WHERE id = ANY($1::uuid[]) AND status IN ('HELD','PENDING_PAYMENT')`, scope,
  );
  if (stuck.rows.length) {
    failures.push(`${stuck.rows.length} booking(s) never reached a settled state`);
  }

  if (serverErrors > 0) failures.push(`${serverErrors} request(s) answered 5xx`);

  return failures;
}

async function report(failures) {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM bookings
     WHERE venue_id IN (SELECT id FROM venues WHERE name = $1)
     GROUP BY status ORDER BY status`, [`Soak ${run}`],
  );

  console.log('  final states');
  for (const row of rows) console.log(`    ${row.status.padEnd(16)} ${row.n}`);
  console.log();

  if (failures.length === 0) {
    console.log('  SOAK PASSED — INV-3, INV-4 and INV-5 hold under chaos\n');
    return;
  }
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n  SOAK FAILED: ${failures.length} finding(s)\n`);
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status >= 500) serverErrors++;
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

await main();
