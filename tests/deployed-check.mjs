/**
 * Smoke test against a DEPLOYED instance. Not part of `npm test`, which runs
 * in process against a local database. This one goes over the wire, so it also
 * exercises the things only a real deployment has: TLS to Neon, nginx or
 * Render's proxy in front, and a cold start.
 *
 *   npm run verify:deployed
 *   API_BASE_URL=... npm run verify:deployed
 */
const API = process.env.API_BASE_URL ?? 'https://atrium-api-c88i.onrender.com';

const call = async (path, opts = {}) => {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
};

const login = async (email) => {
  const r = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'atrium123' }),
  });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
};

const auth = (t) => ({ authorization: `Bearer ${t}` });
const ok = (label, pass, detail = '') =>
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : '  (' + detail + ')'}`);

let fails = 0;
const check = (label, pass, detail) => { if (!pass) fails++; ok(label, pass, detail); };

const health = await call('/health');
console.log('health:', JSON.stringify(health.body), '\n');

const adminA = await login('admin.a@atrium.test');
const adminB = await login('admin.b@atrium.test');
const customer = await login('customer@atrium.test');
console.log('logged in: admin.a, admin.b, customer\n');

// Rooms each admin can see, and one booking belonging to B's venue.
const roomsA = await call('/rooms?limit=100', { headers: auth(adminA) });
const roomsB = await call('/rooms?limit=100', { headers: auth(adminB) });
const roomsC = await call('/rooms?limit=100', { headers: auth(customer) });
const venuesOf = (r) => new Set(r.body.map((x) => x.venue_id));

console.log('CROSS-VENUE SCOPING');
check('venue admin A sees exactly one venue', venuesOf(roomsA).size === 1, `${venuesOf(roomsA).size}`);
check('venue admin B sees exactly one venue', venuesOf(roomsB).size === 1, `${venuesOf(roomsB).size}`);
check('A and B see different venues',
  [...venuesOf(roomsA)][0] !== [...venuesOf(roomsB)][0], 'same venue');
check('customer searches across venues', venuesOf(roomsC).size > 1, `${venuesOf(roomsC).size}`);

// A room that belongs to venue B, held by B so we have a real booking id there.
const roomB = roomsB.body[0];
// A different day each run. The previous run's hold is still HELD -- there is
// no reaper -- so a fixed slot makes the second run fail on INV-1 doing its job.
const slot = (() => {
  const dayOffset = Math.floor(Date.now() / 60000) % 60;
  const t = new Date(Date.now() + (30 + dayOffset * 24) * 3600e3);
  t.setUTCHours(9, 0, 0, 0);
  return { startAt: t.toISOString(), endAt: new Date(t.getTime() + 3600e3).toISOString() };
})();

const heldByB = await call('/bookings/hold', {
  method: 'POST', headers: auth(adminB),
  body: JSON.stringify({ roomId: roomB.id, ...slot, equipment: [] }),
});
console.log('\nHOLD PATH');
check('venue admin B can hold a room in their own venue', heldByB.status === 201,
  `${heldByB.status} ${JSON.stringify(heldByB.body)}`);

const second = await call('/bookings/hold', {
  method: 'POST', headers: auth(adminA),
  body: JSON.stringify({ roomId: roomB.id, ...slot, equipment: [] }),
});
check('venue admin A cannot hold a room in venue B', second.status === 404,
  `${second.status} ${JSON.stringify(second.body)}`);

console.log('\nINV-6 BY DIRECT UUID  (hard cap 3)');
if (heldByB.status === 201) {
  const id = heldByB.body.id;
  const byB = await call(`/bookings/${id}`, { headers: auth(adminB) });
  const byA = await call(`/bookings/${id}`, { headers: auth(adminA) });
  const byCustomer = await call(`/bookings/${id}`, { headers: auth(customer) });
  const noToken = await call(`/bookings/${id}`);

  check('owner venue admin reads it', byB.status === 200, `${byB.status}`);
  check('other venue admin gets 404 with the real UUID', byA.status === 404, `${byA.status}`);
  check('no venue B data in that response', !JSON.stringify(byA.body).includes(id), 'leaked');
  check('unrelated customer gets 404', byCustomer.status === 404, `${byCustomer.status}`);
  check('no token is 401', noToken.status === 401, `${noToken.status}`);
}

console.log('\nERROR MAPPING');
const bad = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'x' }) });
check('schema violation is 400 VALIDATION_FAILED', bad.status === 400 && bad.body.error === 'VALIDATION_FAILED',
  `${bad.status} ${bad.body.error}`);
check('error body carries a correlation id', Boolean(bad.body.correlationId), 'missing');

console.log(fails === 0 ? '\nALL DEPLOYED CHECKS PASSED\n' : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
