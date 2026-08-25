/**
 * Paygate's misbehaviour, decided here rather than scattered through the
 * handlers, so it can be tested without standing up HTTP.
 *
 * Two things make this usable from a test suite. The generator is seeded, so a
 * run repeats. And `X-Paygate-Force` names one behaviour outright, because a
 * test for duplicate delivery that waits for a 30% chance to fire is a flaky
 * test, and a test that turns the rate up to 100% is testing a different
 * configuration than the one that ships.
 */

/** Rates are from the brief's chaos table. */
export const RATES = {
  duplicate: 0.30,
  race: 0.25,
  transient: 0.10,
  delayed: 0.05,
  badSignature: 0.02,
} as const;

export type Forced =
  | 'duplicate' | 'race' | 'transient' | 'delayed' | 'bad-signature'
  | 'declined' | 'none';

export interface ChaosPlan {
  /** Deliver the webhook twice, with a different delivery id each time. */
  duplicate: boolean;
  /** Fire the webhook before the 202 reaches the caller. */
  race: boolean;
  /** Answer 500. The charge is created anyway — see the note in the server. */
  transient: boolean;
  /** Milliseconds before the first delivery attempt. */
  delayMs: number;
  /** Report the charge as declined rather than succeeded. */
  declined: boolean;
}

/**
 * A small random band on every delivery, not just the 5% long delay.
 *
 * The brief asks for webhooks that arrive out of chronological order relative
 * to `occurred_at`. `occurred_at` is stamped when the charge is created, so
 * jittering the delivery is what actually reorders two charges against each
 * other — a fixed delay would preserve their order exactly.
 */
const JITTER_MS = 400;
const DELAYED_MIN_MS = 60_000;
const DELAYED_MAX_MS = 90_000;

export function planFor(
  forced: Forced | undefined,
  enabled: boolean,
  rand: () => number,
): ChaosPlan {
  const none: ChaosPlan = {
    duplicate: false, race: false, transient: false, delayMs: 0, declined: false,
  };

  // A forced behaviour is honoured whether or not chaos is on: a test asking
  // for a duplicate delivery wants one, not a coin toss.
  if (forced && forced !== 'none') {
    switch (forced) {
      case 'duplicate':     return { ...none, duplicate: true };
      case 'race':          return { ...none, race: true };
      case 'transient':     return { ...none, transient: true };
      case 'delayed':       return { ...none, delayMs: DELAYED_MIN_MS };
      case 'declined':      return { ...none, declined: true };
      // Signature is decided per delivery attempt, not per charge.
      case 'bad-signature': return none;
    }
  }

  if (!enabled) return none;

  return {
    duplicate: rand() < RATES.duplicate,
    race: rand() < RATES.race,
    transient: rand() < RATES.transient,
    delayMs: rand() < RATES.delayed
      ? DELAYED_MIN_MS + Math.floor(rand() * (DELAYED_MAX_MS - DELAYED_MIN_MS))
      : Math.floor(rand() * JITTER_MS),
    declined: false,
  };
}

/**
 * Rolled per delivery attempt, so a duplicated webhook can have one good
 * signature and one bad — which is the case worth getting right, because the
 * bad one must be refused without the good one being lost.
 */
export function signatureIsBad(
  forced: Forced | undefined,
  enabled: boolean,
  rand: () => number,
): boolean {
  if (forced === 'bad-signature') return true;
  if (!enabled) return false;
  return rand() < RATES.badSignature;
}

/** Seeded, so a run repeats. Same generator as the seed script. */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}
