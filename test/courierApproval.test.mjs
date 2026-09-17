import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createRequireApprovedCourier,
  isApprovedCourier,
} from '../src/courierApproval.js';

const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function fakeClient({ courier = null, error = null } = {}) {
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: courier, error }; },
  };
  return { from: () => query };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('approval requires both the approved status and verified flag', () => {
  assert.equal(isApprovedCourier({ verification_status: 'approved', is_verified: true }), true);
  assert.equal(isApprovedCourier({ verification_status: 'approved', is_verified: false }), false);
  assert.equal(isApprovedCourier({ verification_status: 'pending', is_verified: true }), false);
  assert.equal(isApprovedCourier({ verification_status: null, is_verified: true }), false);
});

for (const status of ['pending', 'rejected', null]) {
  test(`the operational guard blocks a ${status ?? 'null-status'} courier`, async () => {
    const guard = createRequireApprovedCourier({
      client: fakeClient({
        courier: { id: 'courier-1', verification_status: status, is_verified: false },
      }),
      logger: { error() {} },
    });
    const res = fakeResponse();
    let nextCalled = false;

    await guard({ userId: 'courier-1' }, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Courier approval required');
    assert.equal(res.body.verificationStatus, status || 'pending');
  });
}

test('the operational guard allows an approved, verified courier', async () => {
  const courier = { id: 'courier-1', verification_status: 'approved', is_verified: true };
  const guard = createRequireApprovedCourier({
    client: fakeClient({ courier }),
    logger: { error() {} },
  });
  const req = { userId: 'courier-1' };
  const res = fakeResponse();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.approvedCourier, courier);
});

test('the operational guard rejects an authenticated user with no courier row', async () => {
  const guard = createRequireApprovedCourier({
    client: fakeClient(),
    logger: { error() {} },
  });
  const res = fakeResponse();

  await guard({ userId: 'customer-1' }, res, () => assert.fail('next must not be called'));

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.details, 'User is not a courier');
});

test('approval lookup failures fail closed', async () => {
  const guard = createRequireApprovedCourier({
    client: fakeClient({ error: new Error('database unavailable') }),
    logger: { error() {} },
  });
  const res = fakeResponse();

  await guard({ userId: 'courier-1' }, res, () => assert.fail('next must not be called'));

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to verify courier approval');
});

const OPERATIONAL_ROUTES = [
  ['get', '/courier/availability'],
  ['put', '/courier/availability'],
  ['post', '/courier/orders/:id/arrived'],
  ['get', '/courier/orders/active'],
  ['get', '/courier/jobs/open'],
  ['post', '/courier/jobs/:id/accept'],
  ['post', '/courier/orders/:id/drop'],
  ['patch', '/courier/orders/:id/location'],
  ['post', '/courier/orders/:id/pickup'],
  ['post', '/courier/orders/:id/complete'],
  ['get', '/courier/map'],
];

for (const [method, path] of OPERATIONAL_ROUTES) {
  test(`${method.toUpperCase()} ${path} is approval-gated`, () => {
    assert.ok(
      serverSource.includes(
        `app.${method}('${path}', requireAuth, requireApprovedCourier,`,
      ),
      `${method.toUpperCase()} ${path} must run requireApprovedCourier after authentication`,
    );
  });
}

test('courier onboarding status remains available while approval is pending', () => {
  assert.ok(
    serverSource.includes(
      "app.get('/courier/onboarding-status', requireAuth, async",
    ),
  );
});

test('new-job notifications require approved status as well as the verified flag', () => {
  const notificationStart = serverSource.indexOf('async function notifyAvailableCouriers(');
  const notificationEnd = serverSource.indexOf('\n}', notificationStart);
  const notificationSource = serverSource.slice(notificationStart, notificationEnd);

  assert.ok(notificationSource.includes(".eq('is_verified', true)"));
  assert.ok(notificationSource.includes(".eq('verification_status', 'approved')"));
});
