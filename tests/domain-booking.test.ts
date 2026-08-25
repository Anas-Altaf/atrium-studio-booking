/**
 * The booking rules, tested directly.
 *
 * No database in this file. If it needs one, something has leaked back into the
 * domain layer.
 */
import { describe, expect, it } from 'vitest';
import { venuePredicate } from '../src/auth/scope.js';
import {
  effectiveCapacity, holdExpiresAt, hoursBetween, isOpenFor, mergeLines,
  priceOf, unitsFree, validateInterval,
} from '../src/domain/booking.js';
import type { EquipmentTypeRow, LocalWindow } from '../src/domain/types.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const errorCode = (fn: () => void): string => {
  try { fn(); } catch (err) { return (err as { code: string }).code; }
  throw new Error('expected a rejection, got none');
};

describe('mergeLines', () => {
  it('merges two lines naming the same equipment type', () => {
    expect(mergeLines([
      { equipmentTypeId: 'a', quantity: 2 },
      { equipmentTypeId: 'b', quantity: 1 },
      { equipmentTypeId: 'a', quantity: 3 },
    ])).toEqual([
      { equipmentTypeId: 'a', quantity: 5 },
      { equipmentTypeId: 'b', quantity: 1 },
    ]);
  });

  it('leaves distinct lines alone, and handles none', () => {
    expect(mergeLines([{ equipmentTypeId: 'a', quantity: 1 }]))
      .toEqual([{ equipmentTypeId: 'a', quantity: 1 }]);
    expect(mergeLines([])).toEqual([]);
  });
});

describe('validateInterval', () => {
  const ok = () => validateInterval(at(2 * HOUR), at(3 * HOUR), 60, 480, NOW);

  it('accepts an interval inside every rule', () => {
    expect(ok).not.toThrow();
  });

  it('rejects an end at or before the start', () => {
    expect(errorCode(() => validateInterval(at(3 * HOUR), at(2 * HOUR), 60, 480, NOW)))
      .toBe('BAD_INTERVAL');
    expect(errorCode(() => validateInterval(at(2 * HOUR), at(2 * HOUR), 60, 480, NOW)))
      .toBe('BAD_INTERVAL');
  });

  it('rejects anything off the 30 minute grid', () => {
    expect(errorCode(() => validateInterval(
      at(2 * HOUR + 15 * 60_000), at(3 * HOUR + 15 * 60_000), 60, 480, NOW,
    ))).toBe('BAD_GRANULARITY');
  });

  it('accepts a half hour boundary', () => {
    expect(() => validateInterval(at(2.5 * HOUR), at(4 * HOUR), 60, 480, NOW)).not.toThrow();
  });

  it('rejects shorter than the minimum and longer than the maximum', () => {
    expect(errorCode(() => validateInterval(at(2 * HOUR), at(2.5 * HOUR), 60, 480, NOW)))
      .toBe('BAD_DURATION');
    expect(errorCode(() => validateInterval(at(2 * HOUR), at(11 * HOUR), 60, 480, NOW)))
      .toBe('BAD_DURATION');
  });

  it('rejects less than an hour of notice, and accepts exactly an hour', () => {
    expect(errorCode(() => validateInterval(at(0.5 * HOUR), at(2 * HOUR), 60, 480, NOW)))
      .toBe('TOO_SOON');
    expect(() => validateInterval(at(HOUR), at(2 * HOUR), 60, 480, NOW)).not.toThrow();
  });

  it('rejects beyond 90 days, and accepts the 90th', () => {
    expect(errorCode(() => validateInterval(at(91 * DAY), at(91 * DAY + HOUR), 60, 480, NOW)))
      .toBe('TOO_FAR');
    expect(() => validateInterval(at(90 * DAY), at(90 * DAY + HOUR), 60, 480, NOW))
      .not.toThrow();
  });
});

describe('isOpenFor', () => {
  const hours = { mon: [['08:00', '22:00']] as [string, string][], sun: [['10:00', '18:00']] as [string, string][] };
  const window = (o: Partial<LocalWindow>): LocalWindow => ({
    dow: 'mon', local_start: '09:00', local_end: '11:00', hours, ...o,
  });

  it('accepts an interval inside the day\'s window', () => {
    expect(isOpenFor(window({}))).toBe(true);
  });

  it('accepts an interval flush against both edges', () => {
    expect(isOpenFor(window({ local_start: '08:00', local_end: '22:00' }))).toBe(true);
  });

  it('rejects an interval that starts before opening or ends after closing', () => {
    expect(isOpenFor(window({ local_start: '07:00', local_end: '09:00' }))).toBe(false);
    expect(isOpenFor(window({ local_start: '21:00', local_end: '23:00' }))).toBe(false);
  });

  it('rejects a day with no published window', () => {
    expect(isOpenFor(window({ dow: 'tue' }))).toBe(false);
  });

  it('uses the right day — Sunday closes earlier', () => {
    expect(isOpenFor(window({ dow: 'sun', local_start: '11:00', local_end: '17:00' }))).toBe(true);
    expect(isOpenFor(window({ dow: 'sun', local_start: '17:00', local_end: '19:00' }))).toBe(false);
  });

  it('rejects when the venue publishes no hours at all', () => {
    expect(isOpenFor(window({ hours: null }))).toBe(false);
  });
});

describe('effectiveCapacity', () => {
  const type = (units: number, buffer: string): EquipmentTypeRow => ({
    id: 't', venue_id: 'v', hourly_rate_minor: 0,
    units_owned: units, overbooking_buffer: buffer,
  });

  it('is the units owned when no buffer is set', () => {
    expect(effectiveCapacity(type(3, '0'))).toBe(3);
    expect(effectiveCapacity(type(10, '0'))).toBe(10);
  });

  it('a 10% buffer on 3 units buys nothing, because it floors', () => {
    // The case the concurrency proof runs: 3 units, 200 requests, 3 successes.
    // A buffer that rounded up would let a fourth through and break INV-2.
    expect(effectiveCapacity(type(3, '0.100'))).toBe(3);
  });

  it('a 10% buffer on 10 units adds one', () => {
    expect(effectiveCapacity(type(10, '0.100'))).toBe(11);
  });

  it('reports what is free, never negative', () => {
    expect(unitsFree(type(10, '0'), 4)).toBe(6);
    expect(unitsFree(type(10, '0'), 10)).toBe(0);
    expect(unitsFree(type(10, '0'), 12)).toBe(0);
  });
});

describe('priceOf', () => {
  const room = { hourly_rate_minor: 5_000 };
  const camera: EquipmentTypeRow = {
    id: 'cam', venue_id: 'v', hourly_rate_minor: 1_000,
    units_owned: 5, overbooking_buffer: '0',
  };

  it('charges room hours when there is no equipment', () => {
    expect(priceOf(room, [], [], at(0), at(2 * HOUR))).toBe(10_000);
  });

  it('charges equipment per unit per hour', () => {
    expect(priceOf(room, [camera], [{ equipmentTypeId: 'cam', quantity: 2 }],
      at(0), at(2 * HOUR))).toBe(14_000);
  });

  it('handles a half hour', () => {
    expect(priceOf(room, [], [], at(0), at(1.5 * HOUR))).toBe(7_500);
  });

  it('ignores a line whose type was not locked, rather than pricing it at zero silently', () => {
    // The service refuses the request before this point; asserted so a future
    // caller cannot get free equipment by naming a type that was not loaded.
    expect(priceOf(room, [], [{ equipmentTypeId: 'ghost', quantity: 9 }],
      at(0), at(HOUR))).toBe(5_000);
  });
});

describe('hoursBetween and holdExpiresAt', () => {
  it('measures hours, including fractions', () => {
    expect(hoursBetween(at(0), at(HOUR))).toBe(1);
    expect(hoursBetween(at(0), at(1.5 * HOUR))).toBe(1.5);
  });

  it('puts the expiry the TTL ahead of the given instant', () => {
    expect(holdExpiresAt(8, NOW)).toBe(new Date(NOW + 8 * 60_000).toISOString());
  });
});

describe('venuePredicate', () => {
  const scope = (role: string, venueId: string | null) =>
    ({ userId: 'u', role, venueId }) as never;

  it('confines venue-scoped roles and leaves everyone else alone', () => {
    expect(venuePredicate(scope('VENUE_ADMIN', 'v1'), 'r.venue_id', 2))
      .toEqual({ sql: 'r.venue_id = $2', params: ['v1'] });
    expect(venuePredicate(scope('VENUE_STAFF', 'v1'), 'r.venue_id', 2))
      .toEqual({ sql: 'r.venue_id = $2', params: ['v1'] });
  });

  it('leaves a customer unrestricted — the catalogue is cross-venue by design', () => {
    expect(venuePredicate(scope('CUSTOMER', null), 'r.venue_id', 2))
      .toEqual({ sql: 'TRUE', params: [] });
    expect(venuePredicate(scope('PLATFORM_ADMIN', null), 'r.venue_id', 2))
      .toEqual({ sql: 'TRUE', params: [] });
  });
});
