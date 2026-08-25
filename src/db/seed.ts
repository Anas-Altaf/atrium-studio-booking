/**
 * One script, one code path, two volumes.
 *
 *   --profile=demo   8 venues,  60 rooms,   200 equipment units,  25,000 bookings,   400 users
 *   --profile=full  40 venues, 800 rooms, 2,500 equipment units, 250,000 bookings, 5,000 users
 *
 * Bookings are generated slot by slot per room per day rather than at random,
 * because the exclusion constraint would reject overlapping inserts and a
 * random generator would spend its time losing to it. Slots are skipped
 * probabilistically to leave realistic gaps.
 */
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { migrate } from './migrate.js';

type ProfileName = 'demo' | 'full';

interface Profile {
  venues: number; roomsPerVenue: number; equipmentTypesPerVenue: number;
  unitsPerType: number; users: number; bookings: number; months: number;
  cities: { name: string; timezone: string }[];
}

const PROFILES: Record<ProfileName, Profile> = {
  demo: {
    venues: 8, roomsPerVenue: 8, equipmentTypesPerVenue: 5, unitsPerType: 5,
    users: 400, bookings: 25_000, months: 6,
    cities: [{ name: 'Karachi', timezone: 'Asia/Karachi' }],
  },
  full: {
    venues: 40, roomsPerVenue: 20, equipmentTypesPerVenue: 6, unitsPerType: 10,
    users: 5_000, bookings: 250_000, months: 24,
    cities: [
      { name: 'Karachi', timezone: 'Asia/Karachi' },
      { name: 'Dubai',   timezone: 'Asia/Dubai' },
      { name: 'London',  timezone: 'Europe/London' },
    ],
  },
};

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

    const roomsByVenue = new Map<string, { id: string; rate: number }[]>();
    for (const [i, venueId] of venueIds.entries()) {
      const city = p.cities[i % p.cities.length]!;
      const rooms: { id: string; rate: number }[] = [];
      for (let r = 0; r < p.roomsPerVenue; r++) {
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

      for (let e = 0; e < p.equipmentTypesPerVenue; e++) {
        await client.query(
          `INSERT INTO equipment_types
             (venue_id, name, hourly_rate_minor, units_owned, overbooking_buffer)
           VALUES ($1, $2, $3, $4, $5)`,
          [venueId, `${EQUIPMENT[e % EQUIPMENT.length]}`, between(500, 3_000) * 100,
           p.unitsPerType, e === 0 ? 0.100 : 0],
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

async function seedBookings(
  client: import('pg').PoolClient,
  p: Profile,
  venueIds: string[],
  roomsByVenue: Map<string, { id: string; rate: number }[]>,
  customerIds: string[],
  policyId: string,
): Promise<void> {
  const STATUSES = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
  const spanMs = p.months * 30 * 24 * 3_600_000;
  const originMs = Date.now() - spanMs * 0.75;

  let written = 0;
  const batch: unknown[][] = [];

  outer:
  for (let day = 0; written < p.bookings; day++) {
    const dayStart = originMs + day * 24 * 3_600_000;
    if (dayStart > originMs + spanMs) break;

    for (const venueId of venueIds) {
      for (const room of roomsByVenue.get(venueId)!) {
        // Walk the day in slots, leaving the 15 minute turnaround between them.
        let cursor = alignHalfHour(dayStart + 9 * 3_600_000);
        const dayEnd = dayStart + 21 * 3_600_000;

        while (cursor < dayEnd && written < p.bookings) {
          const hours = between(1, 4);
          const start = cursor;
          const end = start + hours * 3_600_000;
          cursor = alignHalfHour(end + 15 * 60_000 + between(0, 2) * 1_800_000);

          if (rand() < 0.45) continue;           // leave gaps

          batch.push([
            venueId, room.id, pick(customerIds), pick(STATUSES),
            new Date(start).toISOString(), new Date(end).toISOString(),
            policyId, room.rate * hours,
          ]);
          written++;

          if (batch.length >= 1_000) {
            await flush(client, batch);
            batch.length = 0;
            if (written % 25_000 === 0) process.stdout.write(`  ${written} bookings\n`);
          }
          if (written >= p.bookings) break outer;
        }
      }
    }
  }
  if (batch.length) await flush(client, batch);
  process.stdout.write(`  ${written} bookings\n`);
}

function alignHalfHour(ms: number): number {
  return Math.ceil(ms / 1_800_000) * 1_800_000;
}

async function flush(client: import('pg').PoolClient, batch: unknown[][]): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  batch.forEach((row, i) => {
    const b = i * 8;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::booking_status,$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    params.push(...row);
  });
  await client.query(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at, policy_version_id, total_minor)
     VALUES ${values.join(',')}
     ON CONFLICT DO NOTHING`,
    params,
  );
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
