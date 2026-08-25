/**
 * The correlation id has to be ours. Fastify's default `request-id` header
 * would let a caller pin every request to one id, and a value carrying a
 * newline would throw on the response header — a 500 on a good request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await build();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const idOf = async (headers: Record<string, string>): Promise<string> => {
  const res = await app.inject({ method: 'GET', url: '/health', headers });
  return res.headers['x-correlation-id'] as string;
};

describe('correlation id', () => {
  it('accepts x-correlation-id and echoes it back', async () => {
    const supplied = 'trace-0123456789abcdef';
    expect(await idOf({ 'x-correlation-id': supplied })).toBe(supplied);
  });

  it('ignores request-id, which Fastify would otherwise honour', async () => {
    const forged = 'forged-by-the-caller';
    expect(await idOf({ 'request-id': forged })).not.toBe(forged);
  });

  it('generates one when no header is supplied', async () => {
    const first = await idOf({});
    const second = await idOf({});
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('replaces an id carrying a newline rather than echoing it', async () => {
    const injected = 'abcdefgh\nlevel=30 msg="not a real log line"';
    const id = await idOf({ 'x-correlation-id': injected });
    expect(id).not.toContain('\n');
    expect(id).not.toBe(injected);
  });

  it('replaces an id that is too long', async () => {
    const id = await idOf({ 'x-correlation-id': 'a'.repeat(200) });
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
