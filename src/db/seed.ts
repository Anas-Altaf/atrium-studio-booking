/**
 * One script, one code path, two volumes.
 *
 *   --profile=demo   8 venues,  60 rooms,   200 equipment units,  25,000 bookings,   400 users
 *   --profile=full  40 venues, 800 rooms, 2,500 equipment units, 250,000 bookings, 5,000 users
 *
 * Those are the volumes the brief specifies, so they are stated here as totals
 * and distributed across venues rather than expressed per-venue and multiplied.
 * Per-venue counts do not divide evenly -- 60 rooms over 8 venues, 2,500 units
 * over 40 -- and the earlier form quietly produced 64 rooms and 2,400 units.
 * A benchmark is only reproducible if the dataset is the one described.
 *
 * Bookings are generated slot by slot per room per day rather than at random,
 * because the exclusion constraint would reject overlapping inserts and a
 * random generator would spend its time losing to it. The first pass skips
 * slots probabilistically to leave realistic gaps, which costs roughly 45% of
 * the calendar's capacity; later passes return and fill until the target count
 * is actually in the table.
 */
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { migrate } from './migrate.js';

type ProfileName = 'demo' | 'full';

/** Totals, as the brief states them. Rooms and units are spread over venues. */
interface Profile {
  venues: number; rooms: number; equipmentTypesPerVenue: number;
  equipmentUnits: number; users: number; bookings: number; months: number;
  cities: { name: string; timezone: string }[];
}

const PROFILES: Record<ProfileName, Profile> = {
  demo: {
    venues: 8, rooms: 60, equipmentTypesPerVenue: 5, equipmentUnits: 200,
    users: 400, bookings: 25_000, months: 6,
    cities: [{ name: 'Karachi', timezone: 'Asia/Karachi' }],
  },
  full: {
    venues: 40, rooms: 800, equipmentTypesPerVenue: 6, equipmentUnits: 2_500,
    users: 5_000, bookings: 250_000, months: 24,
    cities: [
      { name: 'Karachi', timezone: 'Asia/Karachi' },
      { name: 'Dubai',   timezone: 'Asia/Dubai' },
      { name: 'London',  timezone: 'Europe/London' },
    ],
  },
};

/**
 * Splits a total across n buckets, largest first, never differing by more than
 * one. 60 rooms over 8 venues is four venues with 8 and four with 7 -- which is
 * also what real estate looks like.
 */
function spread(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

const AMENITIES = ['wifi', 'blackout', 'soundproof', 'daylight', 'green_screen',
                   'piano', 'kitchen', 'parking', 'cyclorama', 'wheelchair_access'];
const EQUIPMENT = ['Camera', 'Light Kit', 'Audio Mixer', 'Boom Mic', 'Tripod', 'Reflector'];

// Deterministic PRNG so two runs of the same profile produce the same data.
let seed = 42;
const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const OPERATING_HOURS = {
  mon: [['08:00', '22:00']], tue: [['08:00', '22:00']], wed: [['08:00', '22:00']],
  thu: [['08:00', '22:00']], fri: [['08:00', '23:00']], sat: [['10:00', '23:00']],
  sun: [['10:00', '18:00']],
};

const DEFAULT_TIERS = [
  { hours_before: 48, room_pct: 100, equipment_pct: 100 },
  { hours_before: 24, room_pct:  50, equipment_pct: 100 },
  { hours_before:  2, room_pct:   0, equipment_pct: 100 },
  { hours_before:  0, room_pct:   0, equipment_pct:   0 },
];

async function seedDatabase(profileName: ProfileName): Promise<void> {
  const p = PROFILES[profileName];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await resetSchema(client);

    const { rows: [platformPolicy] } = await client.query<{ id: string }>(
      `INSERT INTO refund_policy_versions (venue_id, tiers) VALUES (NULL, $1) RETURNING id`,
      [JSON.stringify(DEFAULT_TIERS)],
    );

    const venueIds: string[] = [];
    for (let v = 0; v < p.venues; v++) {
      const city = p.cities[v % p.cities.length]!;
      const { rows: [venue] } = await client.query<{ id: string }>(
        `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [`Atrium ${city.name} ${v + 1}`, city.name, city.timezone,
         JSON.stringify(OPERATING_HOURS), platformPolicy!.id],
      );
      venueIds.push(venue!.id);
    }

    const roomsPerVenue = spread(p.rooms, p.venues);
    const unitsPerVenue = spread(p.equipmentUnits, p.venues);

    const roomsByVenue = new Map<string, { id: string; rate: number }[]>();
    for (const [i, venueId] of venueIds.entries()) {
      const city = p.cities[i % p.cities.length]!;
      const rooms: { id: string; rate: number }[] = [];
      for (let r = 0; r < roomsPerVenue[i]!; r++) {
        const rate = between(2_000, 15_000) * 100;
        const amenities = AMENITIES.filter(() => rand() < 0.35);
        const { rows: [room] } = await client.query<{ id: string }>(
          `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [venueId, `Studio ${String.fromCharCode(65 + r)}`, between(4, 40),
           rate, amenities, city.name],
        );
        rooms.push({ id: room!.id, rate });
      }
      roomsByVenue.set(venueId, rooms);

      // A venue's units are spread over its types the same way, so the totals
      // add up exactly and no type is left owning zero.
      const unitsPerType = spread(unitsPerVenue[i]!, p.equipmentTypesPerVenue);
      for (let e = 0; e < p.equipmentTypesPerVenue; e++) {
        await client.query(
          `INSERT INTO equipment_types
             (venue_id, name, hourly_rate_minor, units_owned, overbooking_buffer)
           VALUES ($1, $2, $3, $4, $5)`,
          [venueId, `${EQUIPMENT[e % EQUIPMENT.length]}`, between(500, 3_000) * 100,
           unitsPerType[e]!, e === 0 ? 0.100 : 0],
        );
      }
    }

    // Five fixed logins, one per role plus a second venue admin elsewhere, so
    // cross-venue isolation can be tested from the deployed instance.
    const hash = await bcrypt.hash('atrium123', 10);
    const fixed = [
      ['customer@atrium.test',    'CUSTOMER',       null],
      ['staff@atrium.test',       'VENUE_STAFF',    venueIds[0]],
      ['admin.a@atrium.test',     'VENUE_ADMIN',    venueIds[0]],
      ['admin.b@atrium.test',     'VENUE_ADMIN',    venueIds[1]],
      ['platform@atrium.test',    'PLATFORM_ADMIN', null],
    ] as const;

    const customerIds: string[] = [];
    for (const [email, role, venueId] of fixed) {
      const { rows: [u] } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, venue_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, hash, role, venueId],
      );
      if (role === 'CUSTOMER') customerIds.push(u!.id);
    }

    for (let u = 0; u < p.users; u++) {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, venue_id)
         VALUES ($1, $2, 'CUSTOMER', NULL) RETURNING id`,
        [`customer${u}@atrium.test`, hash],
      );
      customerIds.push(row!.id);
    }

    await seedBookings(client, p, venueIds, roomsByVenue, customerIds, platformPolicy!.id);

    await client.query('COMMIT');
    await client.query('ANALYZE');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The seed is the one caller allowed to remove append-only rows.
 *
 * Migration 009 rejects TRUNCATE on audit_events and refund_policy_versions,
 * so the reset has to disable those guards deliberately rather than slip past
 * them. ALTER TABLE ... DISABLE TRIGGER requires ownership of the table, which
 * atrium_app does not have under 006 -- so this is a migrator-role operation by
 * construction, not by convention. DDL is transactional in Postgres: if the
 * seed fails midway the guards come back with the rollback.
 */
const TRUNCATE_GUARDS = [
  ['audit_events', 'audit_events_no_truncate'],
  ['refund_policy_versions', 'refund_policy_versions_no_truncate'],
] as const;

async function resetSchema(client: import('pg').PoolClient): Promise<void> {
  for (const [table, trigger] of TRUNCATE_GUARDS) {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }

  await client.query(`TRUNCATE audit_events, booking_line_items, refunds, payments,
    webhook_events, unmatched_webhooks, bookings, rooms, equipment_types, users,
    refund_policy_versions, venues RESTART IDENTITY CASCADE`);

  for (const [table, trigger] of TRUNCATE_GUARDS) {
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

/**
 * The brief names an exact volume per profile, and the numbers it quotes are
 * what the latency targets are measured against, so the seed has to land on
 * them rather than near them.
 *
 * Two reasons the old single pass fell short of 25,000. It counted rows it had
 * generated, not rows the database accepted -- the insert is ON CONFLICT DO
 * NOTHING, which covers the exclusion constraint, so an overlap is dropped
 * silently. And skipping 45% of slots for realistic gaps leaves the calendar
 * with less capacity than the target, so it ran out of days first.
 *
 * Now: pass 0 leaves the gaps, later passes go back and fill them, and every
 * pass counts what actually committed. Refusing to place them is better than
 * quietly seeding a smaller dataset and benchmarking that instead.
 */
async function seedBookings(
  client: import('pg').PoolClient,
  p: Profile,
  venueIds: string[],
  roomsByVenue: Map<string, { id: string; rate: number }[]>,
  customerIds: string[],
  policyId: string,
): Promise<void> {
  const MAX_PASSES = 12;
  let written = 0;

  for (let pass = 0; written < p.bookings; pass++) {
    if (pass >= MAX_PASSES) {
      throw new Error(
        `seed placed ${written} of ${p.bookings} bookings in ${MAX_PASSES} passes. ` +
        `${p.rooms} rooms over ${p.months} months cannot hold the target.`,
      );
    }

    const added = await placeBookings(client, p, venueIds, roomsByVenue, customerIds, policyId, {
      skip: skipFor(p, p.bookings - written),
      target: p.bookings - written,
    });

    if (added === 0) {
      throw new Error(
        `seed stalled at ${written} of ${p.bookings} bookings: a full pass placed nothing.`,
      );
    }

    written += added;
    process.stdout.write(`  pass ${pass}: ${written}/${p.bookings} bookings\n`);
  }
}

/**
 * How often to skip a slot, so one walk of the calendar places roughly the
 * number of bookings still owed and spreads them over the whole window.
 *
 * A fixed skip rate was the bug behind a worse defect than the count. The walk
 * goes day by day from the start of the window and stops when the target is
 * met, so filling 45% of every day it touched meant 250,000 bookings landed in
 * the first 150 days of a 720 day window -- all of them 13 to 18 months in the
 * past, none in the present or future. The volume looked right and the dataset
 * was fiction: every availability query found the calendar empty, so the
 * benchmark measured an anti-join with nothing to do.
 *
 * Capacity per room-day: the 09:00-21:00 walk is 12 hours, and one slot
 * consumes a 1-4 hour booking (mean 2.5) plus the 15 minute turnaround plus a
 * 0-2 half hour gap (mean 0.5), so ~3.25 hours per slot and ~3.7 slots. Taking
 * `remaining / capacity` of them puts the expected placement at exactly the
 * shortfall, wherever in the window it falls.
 */
const SLOTS_PER_ROOM_DAY = 3.7;

function skipFor(p: Profile, remaining: number): number {
  const capacity = p.months * 30 * p.rooms * SLOTS_PER_ROOM_DAY;
  return Math.min(0.98, Math.max(0, 1 - remaining / capacity));
}

/**
 * One walk of the calendar. Returns the number of rows the database accepted,
 * which is not the number attempted.
 */
async function placeBookings(
  client: import('pg').PoolClient,
  p: Profile,
  venueIds: string[],
  roomsByVenue: Map<string, { id: string; rate: number }[]>,
  customerIds: string[],
  policyId: string,
  opts: { skip: number; target: number },
): Promise<number> {
  // Status follows the calendar. A booking last March cannot be CONFIRMED and
  // still waiting to happen, and one three months out cannot be COMPLETED.
  // This is also what puts real work in front of the availability query: only
  // HELD, PENDING_PAYMENT and CONFIRMED are in the exclusion constraint's
  // partial index, so a window in the future has rows to test against while
  // the settled past stays out of the index entirely.
  const PAST = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
  const FUTURE = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CANCELLED'];

  const spanMs = p.months * 30 * 24 * 3_600_000;
  const now = Date.now();
  const originMs = now - spanMs * 0.75;

  // The walk is bounded by rows accepted, not rows attempted. Capping attempts
  // at the shortfall starves the tail: needing one more row, the pass offers
  // exactly one slot, that slot is already taken, and it reports a stall on a
  // calendar with plenty of room left.
  //
  // Overshoot is prevented by the batch instead. A batch never inserts more
  // than its own length, so holding it to the shortfall keeps the final count
  // exact while the earlier batches stay at full size.
  let inserted = 0;
  const batch: unknown[][] = [];
  const flushAt = () => Math.min(1_000, opts.target - inserted);

  outer:
  for (let day = 0; inserted < opts.target; day++) {
    const dayStart = originMs + day * 24 * 3_600_000;
    if (dayStart > originMs + spanMs) break;

    for (const venueId of venueIds) {
      for (const room of roomsByVenue.get(venueId)!) {
        // Walk the day in slots, leaving the 15 minute turnaround between them.
        let cursor = alignHalfHour(dayStart + 9 * 3_600_000);
        const dayEnd = dayStart + 21 * 3_600_000;

        while (cursor < dayEnd) {
          const hours = between(1, 4);
          const start = cursor;
          const end = start + hours * 3_600_000;
          cursor = alignHalfHour(end + 15 * 60_000 + between(0, 2) * 1_800_000);

          if (rand() < opts.skip) continue;      // leave gaps

          batch.push([
            venueId, room.id, pick(customerIds), pick(start < now ? PAST : FUTURE),
            new Date(start).toISOString(), new Date(end).toISOString(),
            policyId, room.rate * hours,
          ]);

          if (batch.length >= flushAt()) {
            inserted += await flush(client, batch);
            batch.length = 0;
            if (inserted >= opts.target) break outer;
          }
        }
      }
    }
  }

  if (batch.length) inserted += await flush(client, batch);
  return inserted;
}

function alignHalfHour(ms: number): number {
  return Math.ceil(ms / 1_800_000) * 1_800_000;
}

/** Returns rows accepted. A row lost to the exclusion constraint is not one. */
async function flush(client: import('pg').PoolClient, batch: unknown[][]): Promise<number> {
  const values: string[] = [];
  const params: unknown[] = [];
  batch.forEach((row, i) => {
    const b = i * 8;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::booking_status,$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    params.push(...row);
  });
  const { rowCount } = await client.query(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at, policy_version_id, total_minor)
     VALUES ${values.join(',')}
     ON CONFLICT DO NOTHING`,
    params,
  );
  return rowCount ?? 0;
}

const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = (profileArg?.split('=')[1] ?? 'demo') as ProfileName;

if (!PROFILES[profile]) {
  console.error(`unknown profile: ${profile}. use --profile=demo or --profile=full`);
  process.exit(1);
}

process.stdout.write(`seeding profile=${profile}\n`);
await migrate();
await seedDatabase(profile);
process.stdout.write('done\n');
await pool.end();
