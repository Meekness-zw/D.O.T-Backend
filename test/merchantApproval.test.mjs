import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createRequireApprovedMerchant,
  isApprovedMerchant,
} from '../src/merchantApproval.js';

const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function fakeClient({ merchant = null, error = null } = {}) {
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: merchant, error }; },
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
  assert.equal(isApprovedMerchant({ approval_status: 'approved', is_verified: true }), true);
  assert.equal(isApprovedMerchant({ approval_status: 'approved', is_verified: false }), false);
  assert.equal(isApprovedMerchant({ approval_status: 'pending', is_verified: true }), false);
  assert.equal(isApprovedMerchant({ approval_status: null, is_verified: true }), false);
});

for (const status of ['pending', 'rejected', null]) {
  test(`the operational guard blocks a ${status ?? 'null-status'} merchant`, async () => {
    const guard = createRequireApprovedMerchant({
      client: fakeClient({
        merchant: { id: 'merchant-1', approval_status: status, is_verified: false },
      }),
      logger: { error() {} },
    });
    const res = fakeResponse();
    let nextCalled = false;

    await guard({ userId: 'merchant-1' }, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Merchant approval required');
    assert.equal(res.body.approvalStatus, status || 'pending');
  });
}

test('the operational guard allows an approved, verified merchant', async () => {
  const guard = createRequireApprovedMerchant({
    client: fakeClient({
      merchant: { id: 'merchant-1', approval_status: 'approved', is_verified: true },
    }),
    logger: { error() {} },
  });
  const res = fakeResponse();
  let nextCalled = false;

  await guard({ userId: 'merchant-1' }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('the operational guard rejects an authenticated user with no merchant row', async () => {
  const guard = createRequireApprovedMerchant({
    client: fakeClient({ merchant: null }),
    logger: { error() {} },
  });
  const res = fakeResponse();

  await guard({ userId: 'not-a-merchant' }, res, () => assert.fail('next must not be called'));

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Forbidden');
});

test('approval lookup failures fail closed', async () => {
  const guard = createRequireApprovedMerchant({
    client: fakeClient({ error: new Error('db down') }),
    logger: { error() {} },
  });
  const res = fakeResponse();

  await guard({ userId: 'merchant-1' }, res, () => assert.fail('next must not be called'));

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to verify merchant approval');
});

const OPERATIONAL_ROUTES = [
  ['patch', '/orders/:id'],
  ['post', '/merchant/orders/:id/confirm-dispatch'],
];

for (const [method, path] of OPERATIONAL_ROUTES) {
  test(`${method.toUpperCase()} ${path} is approval-gated`, () => {
    assert.ok(
      serverSource.includes(
        `app.${method}('${path}', requireAuth, requireApprovedMerchant,`,
      ),
      `${method.toUpperCase()} ${path} must run requireApprovedMerchant after authentication`,
    );
  });
}

// Storefront setup must stay reachable while a merchant is pending approval —
// otherwise they cannot finish building their catalog before their first
// review, and re-approval after a fix becomes needlessly slow.
const SETUP_ROUTES_STAY_OPEN = [
  ["app.post('/merchants/onboarding', requireAuth, async"],
  ["app.get('/merchant/onboarding-status', requireAuth, async"],
  ["app.post('/merchant/products', requireAuth, async"],
  ["app.patch('/merchant/stores/:id', requireAuth, async"],
];

for (const [needle] of SETUP_ROUTES_STAY_OPEN.map((x) => [x])) {
  test(`setup route stays open while pending: ${needle}`, () => {
    assert.ok(serverSource.includes(needle), `expected to find: ${needle}`);
  });
}
