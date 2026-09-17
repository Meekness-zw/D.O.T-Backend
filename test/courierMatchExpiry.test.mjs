/**
 * Two related courier-order-lifecycle changes, tested the same way the rest
 * of this file's inline route logic is tested elsewhere (routeOrdering.test.mjs,
 * courierApproval.test.mjs): structural assertions against the source, since
 * server.js builds its Supabase client from env vars at module scope and
 * isn't set up to run with an injected mock.
 *
 * 1. A courier may drop an accepted job any time before pickup — no time
 *    limit — as long as they haven't already collected it from the store.
 * 2. An order nobody accepts within 45 minutes disappears from every
 *    courier's open-jobs list until the merchant reposts it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `could not find end marker after start: ${endMarker}`);
  return src.slice(start, end);
}

const dropRoute = slice(
  "app.post('/courier/orders/:id/drop'",
  "app.patch('/courier/orders/:id/location'",
);

test('drop no longer enforces a time window', () => {
  assert.ok(!dropRoute.includes('3 * 60 * 1000'), 'the 3-minute window must be gone');
  assert.ok(!dropRoute.includes('drop window'), 'no more "drop window" wording');
});

test('drop is allowed at any pre-pickup status, not just "assigned"', () => {
  assert.ok(
    dropRoute.includes('COURIER_PRE_PICKUP_STATUSES.includes(order.status)'),
    'drop must check membership in COURIER_PRE_PICKUP_STATUSES instead of order.status !== \'assigned\'',
  );
  assert.ok(
    dropRoute.includes(".in('status', COURIER_PRE_PICKUP_STATUSES)"),
    'the atomic drop update must guard on the full pre-pickup status set',
  );
});

test('COURIER_PRE_PICKUP_STATUSES stops at pickup, matching COURIER_ACTIVE_STATUSES up to that point', () => {
  const constMatch = src.match(/const COURIER_PRE_PICKUP_STATUSES = (\[[^\]]+\]);/);
  assert.ok(constMatch, 'COURIER_PRE_PICKUP_STATUSES must be defined');
  const statuses = JSON.parse(constMatch[1].replace(/'/g, '"'));
  assert.deepEqual(statuses, ['assigned', 'courier_arrived', 'merchant_confirmed']);
  for (const postPickup of ['picked_up', 'in_transit', 'delivery_confirmation_pending']) {
    assert.ok(!statuses.includes(postPickup), `${postPickup} must not be droppable`);
  }
});

test('dropping restarts the unmatched-order clock so it can expire again if unaccepted', () => {
  assert.ok(dropRoute.includes('courier_match_started_at: new Date().toISOString()'));
  assert.ok(dropRoute.includes('courier_match_expired_at: null'));
});

const jobsOpenRoute = slice(
  "app.get('/courier/jobs/open'",
  "app.post('/courier/jobs/:id/accept'",
);

test('open jobs excludes orders whose courier match has expired', () => {
  assert.ok(jobsOpenRoute.includes(".is('courier_match_expired_at', null)"));
});

const patchOrderRoute = slice(
  "app.patch('/orders/:id', requireAuth, requireApprovedMerchant",
  "app.post('/orders/:id/cancel'",
);

test('entering "preparing" starts the unmatched-order clock', () => {
  assert.ok(
    patchOrderRoute.includes("status === 'preparing'") &&
      patchOrderRoute.includes('courier_match_started_at: new Date().toISOString()'),
    'PATCH /orders/:id must stamp courier_match_started_at when the order becomes preparing',
  );
});

const repostRoute = slice(
  "app.post('/merchant/orders/:id/repost'",
  "app.post('/customer/orders/:id/confirm-delivery'",
);

test('repost is merchant-only and approval-gated', () => {
  assert.ok(
    src.includes("app.post('/merchant/orders/:id/repost', requireAuth, requireApprovedMerchant,"),
    'POST /merchant/orders/:id/repost must run requireApprovedMerchant after authentication',
  );
});

test('repost refuses an order that has not actually expired', () => {
  assert.ok(repostRoute.includes('!order.courier_match_expired_at'));
});

test('repost clears the expiry and re-notifies couriers', () => {
  assert.ok(repostRoute.includes('courier_match_expired_at: null'));
  assert.ok(repostRoute.includes('notifyAvailableCouriers('));
});

test('the 45-minute sweep only touches unaccepted orders, never an accepted-but-unpicked-up one', () => {
  const sweepStart = src.indexOf('async function expireUnmatchedCourierJobs()');
  assert.ok(sweepStart > 0);
  const sweepEnd = src.indexOf('\napp.listen(PORT', sweepStart);
  const sweep = src.slice(sweepStart, sweepEnd);
  assert.ok(sweep.includes(".is('courier_id', null)"), 'must only match orders with no courier assigned');
  assert.ok(src.includes('const COURIER_MATCH_TIMEOUT_MS = 45 * 60 * 1000'));
});

test('the sweep is scheduled to run periodically', () => {
  assert.ok(src.includes('setInterval(expireUnmatchedCourierJobs, 3 * 60 * 1000)'));
});
