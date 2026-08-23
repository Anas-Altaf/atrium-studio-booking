/**
 * The error handler has to actually be reached.
 *
 * It was registered after the route plugins, and a plugin registered with
 * app.register() captures the error handler in force when its encapsulation
 * context is created — so the handler never applied to a single route. A Zod
 * failure came back as a 500 carrying the raw validation detail. Deploying is
 * what found it; nothing in the suite was looking at response bodies.
 *
 * These assert on the body, not just the status.
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

describe('error mapping', () => {
  it('a schema violation is 400 VALIDATION_FAILED, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(body.correlationId).toBeTruthy();
  });

  it('a rejected login is 401 UNAUTHORIZED with our shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@atrium.test', password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.correlationId).toBeTruthy();
  });

  it('a missing token is 401, and carries the correlation id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bookings/00000000-0000-0000-0000-000000000000',
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).correlationId).toBeTruthy();
  });

  it('the correlation id in the body is the one the caller supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-correlation-id': 'trace-me-0001' },
      payload: { email: 'not-an-email' },
    });

    expect(JSON.parse(res.body).correlationId).toBe('trace-me-0001');
    expect(res.headers['x-correlation-id']).toBe('trace-me-0001');
  });
});
