/**
 * THE CONCURRENCY PROOF  (INV-1, INV-2)
 *
 *   npm run proof            # against docker compose, three replicas behind nginx
 *   BASE_URL=... npm run proof
 *
 * Runs against the load balancer, never against a single replica. A proof
 * against one process would not distinguish this design from an in-memory
 * mutex, which is exactly the distinction being tested.
 *
 * Phase A  200 concurrent holds on the SAME room and the SAME one hour slot.
 *          Expect exactly 1 success, 199 clean 409, zero 5xx.
 *
 * Phase B  200 concurrent holds on 200 DIFFERENT rooms in the same slot, each
 *          asking for 1 unit of an EquipmentType that owns exactly 3.
 *          Rooms are distinct so the room constraint cannot mask the result:
 *          whatever limits this run is the equipment check. Expect at most 3.
 */
import pg from 'pg';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium';
const N = Number(process.env.CONCURRENCY ?? 200);

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

interface Outcome { status: number; body: any; servedBy: string | null }

async function main(): Promise<void> {
  const fixture = await setUpFixture();
  const token = await login();

  const slot = nextFreeSlot();
  console.log(`\ntarget slot: ${slot.startAt} -> ${slot.endAt}`);
  console.log(`load balancer: ${BASE_URL}`);
  console.log(`concurrency: ${N}\n`);

  let failures = 0;

  // ---- Phase A: one room, one slot -------------------------------------
  console.log('PHASE A  one room, one slot, %d concurrent holds', N);
  const a = await fireAll(N, () => hold(token, {
    roomId: fixture.contendedRoomId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    equipment: [],
  }));

  const aSummary = summarise(a);
  console.table(aSummary.byStatus);
  console.log('replicas that served traffic:', [...aSummary.replicas].join(', '));

  const roomsBooked = await countBlocking(fixture.contendedRoomId, slot);
  failures += assert('exactly 1 request succeeded', aSummary.created === 1, `got ${aSummary.created}`);
  failures += assert('exactly 1 booking holds the slot', roomsBooked === 1, `got ${roomsBooked}`);
  failures += assert('every other request got 409', aSummary.conflict === N - 1, `got ${aSummary.conflict}`);
  failures += assert('zero 5xx', aSummary.serverError === 0, `got ${aSummary.serverError}`);
  failures += assert('all three replicas participated', aSummary.replicas.size === 3,
    `saw ${[...aSummary.replicas].join(',') || 'none'}`);

  // ---- Phase B: many rooms, one 3-unit equipment type -------------------
  console.log('\nPHASE B  %d distinct rooms, one EquipmentType owning 3 units', N);
  const b = await fireAll(N, (i) => hold(token, {
    roomId: fixture.spreadRoomIds[i % fixture.spreadRoomIds.length]!,
    startAt: slot.startAt,
    endAt: slot.endAt,
    equipment: [{ equipmentTypeId: fixture.scarceEquipmentId, quantity: 1 }],
  }));

  const bSummary = summarise(b);
  console.table(bSummary.byStatus);

  const unitsOut = await peakUnits(fixture.scarceEquipmentId, slot);
  failures += assert('at most 3 units reserved', unitsOut <= 3, `got ${unitsOut}`);
  failures += assert('exactly 3 units reserved', unitsOut === 3, `got ${unitsOut}`);
  failures += assert('successes match units', bSummary.created === unitsOut,
    `${bSummary.created} created vs ${unitsOut} reserved`);
  failures += assert('zero 5xx', bSummary.serverError === 0, `got ${bSummary.serverError}`);
  failures += assert('no duplicate successes beyond capacity',
    bSummary.created <= 3, `got ${bSummary.created}`);

  console.log(failures === 0 ? '\nPROOF PASSED\n' : `\nPROOF FAILED: ${failures} assertion(s)\n`);
  await db.end();
  process.exit(failures === 0 ? 0 : 1);
}

function assert(label: string, ok: boolean, detail: string): number {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${detail})`}`);
  return ok ? 0 : 1;
}

async function fireAll(
  n: number,
  make: (i: number) => Promise<Outcome>,
): Promise<Outcome[]> {
  // Built first, awaited together: the requests leave at once rather than in
  // sequence, which is the only way the race is real.
  const started = Array.from({ length: n }, (_, i) => make(i));
  return Promise.all(started);
}

async function hold(token: string, body: unknown): Promise<Outcome> {
  try {
    const res = await fetch(`${BASE_URL}/bookings/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: await res.json().catch(() => null),
      servedBy: res.headers.get('x-served-by'),
    };
  } catch (err) {
    return { status: 0, body: { error: String(err) }, servedBy: null };
  }
}

function summarise(outcomes: Outcome[]) {
  const byStatus: Record<string, number> = {};
  const replicas = new Set<string>();
  for (const o of outcomes) {
    byStatus[String(o.status)] = (byStatus[String(o.status)] ?? 0) + 1;
    if (o.servedBy) replicas.add(o.servedBy);
  }
  return {
    byStatus,
    replicas,
    created: outcomes.filter((o) => o.status === 201).length,
    conflict: outcomes.filter((o) => o.status === 409).length,
    serverError: outcomes.filter((o) => o.status >= 500 || o.status === 0).length,
  };
}

async function countBlocking(roomId: string, slot: Slot): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM bookings
     WHERE room_id = $1
       AND status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
       AND reserved_range && tstzrange($2, $3, '[)')`,
    [roomId, slot.startAt, slot.endAt],
  );
  return Number(rows[0]!.n);
}

async function peakUnits(equipmentTypeId: string, slot: Slot): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COALESCE(SUM(li.quantity), 0)::text AS n
     FROM   booking_line_items li
     JOIN   bookings b ON b.id = li.booking_id
     WHERE  li.equipment_type_id = $1
       AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
       AND  b.start_at < $3 AND b.end_at > $2`,
    [equipmentTypeId, slot.startAt, slot.endAt],
  );
  return Number(rows[0]!.n);
}

interface Slot { startAt: string; endAt: string }

/** A slot far enough ahead to satisfy the advance window, aligned to 30 minutes. */
function nextFreeSlot(): Slot {
  // A distinct day per run. Holds from a previous run are still HELD -- there is
  // no reaper yet -- and they stay inside the partial exclusion index and inside
  // the equipment peak query candidate set, so reusing one slot makes each run
  // measure the debris of the last one. See ARCHITECTURE.md 7.2.
  const dayOffset = Math.floor(Date.now() / 60_000) % 60;
  const base = Date.now() + (26 + dayOffset * 24) * 3_600_000;
  const start = Math.ceil(base / 1_800_000) * 1_800_000;
  const at = new Date(start);
  // 12:00 local-ish, inside every seeded venue's operating hours
  at.setUTCHours(9, 0, 0, 0);
  const startAt = at.toISOString();
  const endAt = new Date(at.getTime() + 3_600_000).toISOString();
  return { startAt, endAt };
}

/**
 * Fixture is created directly in the database rather than through the API,
 * so the proof measures the hold path and nothing else.
 */
async function setUpFixture() {
  const { rows: [venue] } = await db.query<{ id: string }>(
    `SELECT id FROM venues ORDER BY created_at, id LIMIT 1`,
  );
  if (!venue) throw new Error('seed the database first: npm run seed');

  // Earlier versions of this fixture deleted the previous run's PROOF rows.
  // That is not possible and should not be: audit_events holds a foreign key to
  // every booking and is append-only, so deleting a booking would require
  // deleting its audit rows, which migration 008 refuses whichever role is
  // connected. The append-only guarantee blocking the test's own cleanup is the
  // guarantee working, so the fixture is per-run instead: every object is
  // tagged with a run id and nothing is ever removed. Rows accumulate across
  // runs, which is what an audit trail is for.
  const runId = Date.now().toString(36);

  const { rows: [equip] } = await db.query<{ id: string }>(
    `INSERT INTO equipment_types
       (venue_id, name, hourly_rate_minor, units_owned, overbooking_buffer)
     VALUES ($1, $2, 100000, 3, 0) RETURNING id`,
    [venue.id, `PROOF Scarce Camera ${runId}`],
  );

  const { rows: [city] } = await db.query<{ city: string }>(
    `SELECT city FROM venues WHERE id = $1`, [venue.id],
  );

  const { rows: [contended] } = await db.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, $2, 10, 500000, '{}', $3) RETURNING id`,
    [venue.id, `PROOF Contended Room ${runId}`, city!.city],
  );

  const spreadRoomIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
       VALUES ($1, $2, 10, 500000, '{}', $3) RETURNING id`,
      [venue.id, `PROOF Spread Room ${runId} ${i}`, city!.city],
    );
    spreadRoomIds.push(r!.id);
  }

  return { contendedRoomId: contended!.id, scarceEquipmentId: equip!.id, spreadRoomIds };
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'customer@atrium.test', password: 'atrium123' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { token: string }).token;
}

await main();
