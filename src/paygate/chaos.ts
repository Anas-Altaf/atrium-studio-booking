/** From the brief's chaos table. */
const RATES = {
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
  duplicate: boolean;
  race: boolean;
  /** Answer 500. The charge is created anyway — see the server. */
  transient: boolean;
  delayMs: number;
  declined: boolean;
}

/**
 * Jitter on every delivery, not just the 5% long delay. `occurred_at` is
 * stamped at creation, so only a varying delay reorders two charges against
 * each other.
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

  // Honoured whether or not chaos is on: a test asking for a duplicate wants
  // one, not a coin toss.
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

  const duplicate = rand() < RATES.duplicate;
  const race = rand() < RATES.race;
  const transient = rand() < RATES.transient;
  const delayed = rand() < RATES.delayed;
  const jitter = Math.floor(rand() * JITTER_MS);

  return {
    duplicate,
    race,
    transient,
    declined: false,
    // A race delivers immediately so the webhook beats the 202 response.
    // A long delay (60s+) still wins.
    delayMs: delayed
      ? DELAYED_MIN_MS + Math.floor(rand() * (DELAYED_MAX_MS - DELAYED_MIN_MS))
      : race ? 0 : jitter,
  };
}

/** Per attempt, so a duplicated webhook can arrive once genuine and once forged. */
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
