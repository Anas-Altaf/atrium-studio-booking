/** Refund terms. No database, no clock — `now` is a parameter. */
import type { EquipmentLineItem, RefundTier } from './types.js';

export interface RefundBreakdown {
  roomMinor: number;
  equipmentMinor: number;
  totalMinor: number;
  /** The tier that applied, for the audit reason. Null when none did. */
  tier: RefundTier | null;
}

const HOUR_MS = 3_600_000;

/**
 * Read from the highest threshold down, so 30 hours out falls past 48 and lands
 * on 24. After the start nothing matches, and nothing is refunded.
 */
export function tierFor(
  tiers: RefundTier[], startAt: string | Date, now: number = Date.now(),
): RefundTier | null {
  const hoursUntilStart = (new Date(startAt).getTime() - now) / HOUR_MS;

  return [...tiers]
    .sort((a, b) => b.hours_before - a.hours_before)
    .find((t) => hoursUntilStart >= t.hours_before) ?? null;
}

export function calculateRefund(
  tiers: RefundTier[],
  startAt: string | Date,
  roomMinor: number,
  equipmentMinor: number,
  now: number = Date.now(),
): RefundBreakdown {
  const tier = tierFor(tiers, startAt, now);
  if (!tier) return { roomMinor: 0, equipmentMinor: 0, totalMinor: 0, tier: null };

  const room = Math.round((roomMinor * tier.room_pct) / 100);
  const equipment = Math.round((equipmentMinor * tier.equipment_pct) / 100);

  return { roomMinor: room, equipmentMinor: equipment, totalMinor: room + equipment, tier };
}

/** From the rates frozen onto the line items, not the type's rate today. */
export function equipmentPortion(lines: EquipmentLineItem[], hours: number): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.hourly_rate_minor * hours, 0);
}

/**
 * By subtraction, not by recomputing the room rate: `priceOf` rounds the sum,
 * so recomputing both halves can miss the total by a minor unit.
 */
export function splitTotal(totalMinor: number, equipmentMinor: number): {
  roomMinor: number; equipmentMinor: number;
} {
  const equipment = Math.min(equipmentMinor, totalMinor);
  return { roomMinor: totalMinor - equipment, equipmentMinor: equipment };
}
