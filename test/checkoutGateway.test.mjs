import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getActiveCheckoutGateway,
  normalizeCheckoutGateway,
  resolveCheckoutGateway,
  setActiveCheckoutGateway,
} from '../src/checkoutGateway.js';
import { mapSmilePayStatus, toSmileCurrency } from '../src/smilePayService.js';

test('ZB Smile Cash is the default gate and Pesepay is the backup', () => {
  const file = path.join(os.tmpdir(), `dot-gateway-${process.pid}.json`);
  const previousFile = process.env.CHECKOUT_GATEWAY_FILE;
  const previousGateway = process.env.CHECKOUT_PAYMENT_GATEWAY;
  process.env.CHECKOUT_GATEWAY_FILE = file;
  delete process.env.CHECKOUT_PAYMENT_GATEWAY;
  try {
    fs.rmSync(file, { force: true });
    assert.equal(getActiveCheckoutGateway(), 'smilepay');
    assert.deepEqual(
      resolveCheckoutGateway({ smileConfigured: true, pesepayConfigured: true }),
      { gateway: 'smilepay', preferred: 'smilepay', backup: 'pesepay', usingBackup: false },
    );
    assert.deepEqual(
      resolveCheckoutGateway({ smileConfigured: false, pesepayConfigured: true }),
      { gateway: 'pesepay', preferred: 'smilepay', backup: 'pesepay', usingBackup: true },
    );
    assert.equal(setActiveCheckoutGateway('pesepay'), 'pesepay');
    assert.equal(getActiveCheckoutGateway(), 'pesepay');
    assert.equal(normalizeCheckoutGateway('nope'), null);
    assert.throws(() => setActiveCheckoutGateway('contipay'));
  } finally {
    fs.rmSync(file, { force: true });
    if (previousFile === undefined) delete process.env.CHECKOUT_GATEWAY_FILE;
    else process.env.CHECKOUT_GATEWAY_FILE = previousFile;
    if (previousGateway === undefined) delete process.env.CHECKOUT_PAYMENT_GATEWAY;
    else process.env.CHECKOUT_PAYMENT_GATEWAY = previousGateway;
  }
});

test('smile cash status and currency mapping never treat an unknown status as paid', () => {
  assert.equal(mapSmilePayStatus('PAID'), 'completed');
  assert.equal(mapSmilePayStatus('CANCELED'), 'failed');
  assert.equal(mapSmilePayStatus('PENDING'), 'pending');
  assert.equal(mapSmilePayStatus('SOMETHING_NEW'), 'pending');
  assert.equal(toSmileCurrency('USD'), '840');
  assert.equal(toSmileCurrency('ZWG'), '924');
});
