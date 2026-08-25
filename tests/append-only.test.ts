/**
 * The audit trail is only evidence if it cannot be edited. Row triggers (008)
 * and the statement-level TRUNCATE guard (009), including the cascade path from
 * `bookings`, which is the one a caller would actually reach for.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';

const APPEND_ONLY = 'ATR02';

afterAll(async () => {
  await pool.end();
});

/** Every case must roll back: these statements are destructive when they work. */
async function attempt(sql: string): Promise<{ code?: string; message: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    return { code: undefined, message: 'statement was permitted' };
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

describe('audit_events is append-only', () => {
  it('rejects TRUNCATE', async () => {
    const { code } = await attempt('TRUNCATE audit_events');
    expect(code).toBe(APPEND_ONLY);
  });

  it('rejects TRUNCATE reached by cascade from bookings', async () => {
    const { code } = await attempt('TRUNCATE bookings CASCADE');
    expect(code).toBe(APPEND_ONLY);
  });

  it('rejects UPDATE', async () => {
    const { code } = await attempt(
      `UPDATE audit_events SET reason = 'edited' WHERE id = (SELECT min(id) FROM audit_events)`,
    );
    expect(code).toBe(APPEND_ONLY);
  });

  it('rejects DELETE', async () => {
    const { code } = await attempt(
      'DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)',
    );
    expect(code).toBe(APPEND_ONLY);
  });
});

describe('refund_policy_versions is immutable', () => {
  it('rejects TRUNCATE', async () => {
    const { code } = await attempt('TRUNCATE refund_policy_versions CASCADE');
    expect(code).toBe(APPEND_ONLY);
  });

  it('rejects UPDATE', async () => {
    const { code } = await attempt(
      `UPDATE refund_policy_versions SET tiers = '[]'::jsonb
       WHERE id = (SELECT id FROM refund_policy_versions LIMIT 1)`,
    );
    expect(code).toBe(APPEND_ONLY);
  });
});

describe('the transition matrix is not application data', () => {
  it('rejects INSERT', async () => {
    const { code } = await attempt(
      `INSERT INTO booking_transitions (from_state, to_state, note)
       VALUES ('EXPIRED', 'CONFIRMED', 'this would break INV-4')`,
    );
    expect(code).toBe(APPEND_ONLY);
  });

  it('rejects TRUNCATE', async () => {
    const { code } = await attempt('TRUNCATE booking_transitions');
    expect(code).toBe(APPEND_ONLY);
  });
});
