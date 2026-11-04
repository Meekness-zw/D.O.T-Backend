import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  ecocashConfigured,
  ecocashMissingConfig,
  ecocashEndUserId,
  mapEcocashStatus,
  buildChargeBody,
  newClientCorrelator,
} = await import('../src/ecocashService.js');

const env = {
  ECOCASH_BASE_URL: 'https://developers.ecocash.co.zw/sandbox/payment/v1',
  ECOCASH_USERNAME: 'user',
  ECOCASH_PASSWORD: 'pass',
  ECOCASH_MERCHANT_CODE: '001535',
  ECOCASH_MERCHANT_PIN: '0000',
  ECOCASH_MERCHANT_NUMBER: '788732685',
  ECOCASH_TERMINAL_ID: 'UAT00003',
  ECOCASH_MERCHANT_NAME: 'DOT DELIVERY',
};

test('EcoCash stays off until every setting is filled in', () => {
  assert.equal(ecocashConfigured({}), false);
  assert.equal(ecocashConfigured(env), true);
  assert.deepEqual(ecocashMissingConfig({ ...env, ECOCASH_MERCHANT_PIN: ' ' }), ['ECOCASH_MERCHANT_PIN']);
});

test('customer numbers are sent the way EcoCash wants them', () => {
  for (const phone of ['+263 77 304 7653', '263773047653', '0773047653', '773047653']) {
    assert.equal(ecocashEndUserId(phone, 'local'), '773047653', phone);
  }
  assert.equal(ecocashEndUserId('+263783047653', 'international'), '263783047653');
});

test('non-EcoCash and malformed numbers are refused', () => {
  assert.equal(ecocashEndUserId('+263712345678'), null); // NetOne
  assert.equal(ecocashEndUserId('+263732345678'), null); // Telecash
  assert.equal(ecocashEndUserId('+447911123456'), null);
  assert.equal(ecocashEndUserId('0771'), null);
  assert.equal(ecocashEndUserId(''), null);
});

test('EcoCash outcomes map to our payment statuses', () => {
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'Charged', responseCode: '00' }), 'completed');
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'COMPLETED' }), 'completed');
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'Refunded' }), 'refunded');
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'FAILED' }), 'failed');
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'Insufficient funds' }), 'failed');
  // Waiting for the customer's PIN, or anything new: ask again rather than guess.
  assert.equal(mapEcocashStatus({ transactionOperationStatus: 'PENDING SUBSCRIBER VALIDATION' }), 'pending');
  assert.equal(mapEcocashStatus({}), 'pending');
  assert.equal(mapEcocashStatus(null), 'pending');
});

test('the charge body matches the documented request', () => {
  const body = buildChargeBody(
    { clientCorrelator: 'DOT1', endUserId: '773047653', amount: 12.345, description: 'DOT order DOT-1', notifyUrl: 'https://api.example/notify' },
    env,
  );
  assert.equal(body.tranType, 'MER');
  assert.equal(body.endUserId, '773047653');
  assert.equal(body.clientCorrelator, 'DOT1');
  assert.equal(body.paymentAmount.charginginformation.amount, 12.35);
  assert.equal(body.paymentAmount.charginginformation.currency, 'USD');
  assert.equal(body.paymentAmount.chargeMetaData.channel, 'WEB');
  assert.equal(body.merchantCode, '001535');
  assert.equal(body.countryCode, 'ZW');
  assert.equal(body.notifyUrl, 'https://api.example/notify');
  assert.equal(buildChargeBody({ clientCorrelator: 'X', endUserId: '1', amount: 1 }, env).notifyUrl, undefined);
});

test('each charge gets its own reference', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newClientCorrelator()));
  assert.equal(ids.size, 50);
});
