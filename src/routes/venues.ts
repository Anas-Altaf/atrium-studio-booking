import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as venueService from '../services/venueService.js';

const tier = z.object({
  hours_before: z.number().int().nonnegative(),
  room_pct: z.number().int().min(0).max(100),
  equipment_pct: z.number().int().min(0).max(100),
});

const policyBody = z.object({
  // A policy with no band covering the last hours before start would refund
  // nothing there by accident rather than by decision.
  tiers: z.array(tier).min(1).refine(
    (ts) => ts.some((t) => t.hours_before === 0),
    { message: 'tiers must include a band at hours_before 0' },
  ),
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const operatingHours = z.record(
  z.string(),
  z.array(z.tuple([z.string().regex(HHMM), z.string().regex(HHMM)])
    .refine(([open, close]) => close > open, { message: 'a window must close after it opens' })),
).refine((h) => Object.keys(h).every((d) => DAYS.includes(d as typeof DAYS[number])),
  { message: `days must be one of ${DAYS.join(', ')}` });

/** Rejected here rather than at the first booking, where it would read as a 500. */
const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, { message: 'not an IANA timezone' });

const venueBody = z.object({
  name: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  timezone,
  operatingHours,
});

const venuePatch = venueBody.partial();

// The brief's booking rules, applied where the inventory is defined rather than
// only where it is booked: 30 minute increments, 1 to 8 hours.
const duration = z.number().int().min(60).max(480).refine((m) => m % 30 === 0,
  { message: 'durations are in 30 minute increments' });

const roomBody = z.object({
  name: z.string().min(1).max(200),
  capacity: z.number().int().positive().max(10_000),
  hourlyRateMinor: z.number().int().nonnegative(),
  amenities: z.array(z.string().min(1).max(60)).max(40).default([]),
  minDurationMin: duration.default(60),
  maxDurationMin: duration.default(480),
}).refine((r) => r.maxDurationMin >= r.minDurationMin,
  { message: 'maxDurationMin must be at least minDurationMin' });

const equipmentBody = z.object({
  name: z.string().min(1).max(200),
  hourlyRateMinor: z.number().int().nonnegative(),
  unitsOwned: z.number().int().positive().max(100_000),
  // The brief caps the buffer at 10%.
  overbookingBuffer: z.number().min(0).max(0.1).default(0),
});

const staffBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['VENUE_STAFF', 'VENUE_ADMIN']),
});

const staffPatch = z.object({
  role: z.enum(['VENUE_STAFF', 'VENUE_ADMIN']).optional(),
  active: z.boolean().optional(),
});

type Id = { Params: { id: string } };

export async function venueRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [app.authenticate] };

  /** The directory: every venue for a customer, their own for venue staff. */
  app.get('/venues', auth, async (req) => {
    const { city } = z.object({ city: z.string().min(1).optional() }).parse(req.query);
    return venueService.list(req.scope, city);
  });

  app.post('/venues', auth, async (req, reply) => {
    const body = venueBody.parse(req.body);
    return reply.code(201).send(await venueService.create(req.scope, body));
  });

  app.get<Id>('/venues/:id', auth,
    async (req) => venueService.findById(req.scope, req.params.id));

  /** Moving a venue carries its rooms' denormalized city with it. */
  app.patch<Id>('/venues/:id', auth, async (req) => {
    const body = venuePatch.parse(req.body);
    return venueService.update(req.scope, req.params.id, body);
  });

  app.get<Id>('/venues/:id/rooms', auth,
    async (req) => venueService.rooms(req.scope, req.params.id));

  app.post<Id>('/venues/:id/rooms', auth, async (req, reply) => {
    const body = roomBody.parse(req.body);
    return reply.code(201).send(await venueService.addRoom(req.scope, req.params.id, body));
  });

  /** The console view, buffer included — `/rooms/:id/equipment` is the customer's. */
  app.get<Id>('/venues/:id/equipment', auth,
    async (req) => venueService.equipment(req.scope, req.params.id));

  app.post<Id>('/venues/:id/equipment', auth, async (req, reply) => {
    const body = equipmentBody.parse(req.body);
    return reply.code(201).send(await venueService.addEquipment(req.scope, req.params.id, body));
  });

  app.get<Id>('/venues/:id/staff', auth,
    async (req) => venueService.staff(req.scope, req.params.id));

  app.post<Id>('/venues/:id/staff', auth, async (req, reply) => {
    const body = staffBody.parse(req.body);
    return reply.code(201).send(await venueService.addStaff(req.scope, req.params.id, body));
  });

  app.patch<{ Params: { id: string; userId: string } }>(
    '/venues/:id/staff/:userId', auth, async (req) => {
      const body = staffPatch.parse(req.body);
      return venueService.updateStaff(req.scope, req.params.id, req.params.userId, body);
    },
  );

  /** The terms a customer agrees to at checkout, and an admin edits from. */
  app.get<Id>('/venues/:id/policy', auth,
    async (req) => venueService.currentPolicy(req.scope, req.params.id));

  app.patch<Id>('/venues/:id/policy', auth, async (req) => {
    const body = policyBody.parse(req.body);
    return venueService.publishPolicy(req.scope, req.params.id, body.tiers);
  });
}
