/**
 * The refund calculator, tested at every boundary.
 *
 * No database in this file. The tiers below are the platform default the seed
 * publishes, which is the brief's table in section 07.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateRefund, equipmentPortion, splitTotal, tierFor,
} from '../src/domain/refund.js';
import type { RefundTier } from '../src/domain/types.js';

const TIERS: RefundTier[] = [
  { hours_before: 48, room_pct: 100, equipment_pct: 100 },
  { hours_before: 24, room_pct: 50, equipment_pct: 100 },
  { hours_before: 2, room_pct: 0, equipment_pct: 100 },
  { hours_before: 0, room_pct: 0, equipment_pct: 0 },
];

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 3_600_000;
const startIn = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

const bandAt = (hours: number) => {
  const tier = tierFor(TIERS, startIn(hours), NOW);
  return tier ? `${tier.room_pct}/${tier.equipment_pct}` : 'none';
};

describe('tierFor', () => {
  it('reads the brief\'s table', () => {
    expect(bandAt(72)).toBe('100/100');   // more than 48 hours before
    expect(bandAt(36)).toBe('50/100');    // 24 to 48
    expect(bandAt(10)).toBe('0/100');     // less than 24, more than 2
    expect(bandAt(1)).toBe('0/0');        // less than 2
  });

  it('treats each threshold as inclusive', () => {
    expect(bandAt(48)).toBe('100/100');
    expect(bandAt(24)).toBe('50/100');
    expect(bandAt(2)).toBe('0/100');
    expect(bandAt(0)).toBe('0/0');
  });

  it('drops a band a minute below the threshold', () => {
    expect(tierFor(TIERS, new Date(NOW + 48 * HOUR - 60_000), NOW)!.room_pct).toBe(50);
    expect(tierFor(TIERS, new Date(NOW + 24 * HOUR - 60_000), NOW)!.room_pct).toBe(0);
  });

  it('matches no tier once the booking has started', () => {
    expect(bandAt(-1)).toBe('none');
  });

  it('does not depend on the order the tiers arrive in', () => {
    const shuffled = [TIERS[2]!, TIERS[0]!, TIERS[3]!, TIERS[1]!];
    expect(tierFor(shuffled, startIn(36), NOW)!.room_pct).toBe(50);
  });
});

describe('calculateRefund', () => {
  it('returns everything more than 48 hours out', () => {
    expect(calculateRefund(TIERS, startIn(72), 10_000, 4_000, NOW)).toEqual({
      roomMinor: 10_000, equipmentMinor: 4_000, totalMinor: 14_000, tier: TIERS[0],
    });
  });

  it('halves the room but keeps all the equipment between 24 and 48', () => {
    const r = calculateRefund(TIERS, startIn(36), 10_000, 4_000, NOW);
    expect(r.roomMinor).toBe(5_000);
    expect(r.equipmentMinor).toBe(4_000);
    expect(r.totalMinor).toBe(9_000);
  });

  it('keeps the room but returns the equipment under 24 hours', () => {
    const r = calculateRefund(TIERS, startIn(10), 10_000, 4_000, NOW);
    expect(r.roomMinor).toBe(0);
    expect(r.equipmentMinor).toBe(4_000);
  });

  it('returns nothing inside two hours', () => {
    expect(calculateRefund(TIERS, startIn(1), 10_000, 4_000, NOW).totalMinor).toBe(0);
  });

  it('returns nothing after the booking has started', () => {
    const r = calculateRefund(TIERS, startIn(-1), 10_000, 4_000, NOW);
    expect(r).toEqual({ roomMinor: 0, equipmentMinor: 0, totalMinor: 0, tier: null });
  });

  it('handles a booking with no equipment', () => {
    expect(calculateRefund(TIERS, startIn(36), 10_000, 0, NOW).totalMinor).toBe(5_000);
  });

  it('handles equipment with no room charge', () => {
    expect(calculateRefund(TIERS, startIn(10), 0, 4_000, NOW).totalMinor).toBe(4_000);
  });

  it('rounds a half percent rather than truncating it', () => {
    // 4,999 at 50% is 2,499.5. Truncating would quietly keep half a unit.
    expect(calculateRefund(TIERS, startIn(36), 4_999, 0, NOW).roomMinor).toBe(2_500);
  });

  it('refunds nothing when a venue publishes no tiers at all', () => {
    expect(calculateRefund([], startIn(72), 10_000, 4_000, NOW).totalMinor).toBe(0);
  });

  it('honours a venue that overrides the platform default', () => {
    const strict: RefundTier[] = [{ hours_before: 0, room_pct: 0, equipment_pct: 0 }];
    expect(calculateRefund(strict, startIn(72), 10_000, 4_000, NOW).totalMinor).toBe(0);

    const generous: RefundTier[] = [{ hours_before: 0, room_pct: 100, equipment_pct: 100 }];
    expect(calculateRefund(generous, startIn(0.5), 10_000, 4_000, NOW).totalMinor).toBe(14_000);
  });
});

describe('equipmentPortion and splitTotal', () => {
  const lines = [
    { equipment_type_id: 'a', quantity: 2, hourly_rate_minor: 1_000 },
    { equipment_type_id: 'b', quantity: 1, hourly_rate_minor: 500 },
  ];

  it('prices line items at the rate frozen onto them', () => {
    expect(equipmentPortion(lines, 2)).toBe(5_000);
    expect(equipmentPortion(lines, 1.5)).toBe(3_750);
    expect(equipmentPortion([], 3)).toBe(0);
  });

  it('derives the room half by subtraction, so the two always sum to the total', () => {
    const split = splitTotal(14_000, 4_000);
    expect(split).toEqual({ roomMinor: 10_000, equipmentMinor: 4_000 });
    expect(split.roomMinor + split.equipmentMinor).toBe(14_000);
  });

  it('never lets the equipment half exceed what was charged', () => {
    // Rounding upstream could otherwise produce a negative room portion and
    // refund more than the booking took.
    expect(splitTotal(3_000, 5_000)).toEqual({ roomMinor: 0, equipmentMinor: 3_000 });
  });
});
