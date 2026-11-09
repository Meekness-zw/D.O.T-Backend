import assert from 'node:assert/strict';
import { test } from 'node:test';

const { isMerchantController, blockedWhileActing, controllerEmails } = await import('../src/merchantControl.js');

test('only the listed DOT email can manage stores', () => {
  assert.equal(isMerchantController({ email: 'admin@deliveryontime.co.zw' }, {}), true);
  assert.equal(isMerchantController({ email: 'ADMIN@DeliveryOnTime.co.zw' }, {}), true);
  assert.equal(isMerchantController({ email: 'accounts@deliveryontime.co.zw' }, {}), false);
  assert.equal(isMerchantController({ email: 'admin@deliveryontime.co.zw', is_active: false }, {}), false);
  assert.equal(isMerchantController({}, {}), false);
  assert.equal(isMerchantController(null, {}), false);
});

test('the list can be changed in settings', () => {
  const env = { MERCHANT_CONTROLLER_EMAILS: 'ops@deliveryontime.co.zw, admin@deliveryontime.co.zw' };
  assert.deepEqual(controllerEmails(env), ['ops@deliveryontime.co.zw', 'admin@deliveryontime.co.zw']);
  assert.equal(isMerchantController({ email: 'ops@deliveryontime.co.zw' }, env), true);
});

test('money, sign-in and deleting stay with the merchant', () => {
  for (const [method, path] of [
    ['POST', '/merchants/onboarding/payout-method'],
    ['POST', '/wallet/withdraw'],
    ['DELETE', '/users/me/account'],
    ['POST', '/auth/pin/set'],
    ['POST', '/users/me/add-role'],
    ['PUT', '/users/me/push-token'],
    ['PATCH', '/users/me/payment-methods/abc'],
  ]) {
    assert.ok(blockedWhileActing(method, path), `${method} ${path}`);
  }
});

test('running the store is allowed', () => {
  for (const [method, path] of [
    ['GET', '/merchant/orders'],
    ['PATCH', '/merchant/orders/123/status'],
    ['PATCH', '/merchant/profile'],
    ['GET', '/merchant/payout-method'],
    ['GET', '/wallet/withdrawals'],
    ['POST', '/merchant/products'],
  ]) {
    assert.equal(blockedWhileActing(method, path), null, `${method} ${path}`);
  }
});
