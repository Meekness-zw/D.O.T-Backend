import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmsGuard } from '../src/smsGuard.js';

const SMS_ENV_KEYS = [
  'SMS_MAX_PER_PHONE_HOUR',
  'SMS_MAX_PER_PHONE_DAY',
  'SMS_MAX_PER_IP_HOUR',
  'SMS_MAX_PER_IP_DAY',
  'SMS_MAX_PHONES_PER_IP_DAY',
  'SMS_MAX_GLOBAL_DAY',
  'SMS_MAX_FALLBACK_GLOBAL_DAY',
  'SMS_ALLOWED_COUNTRY_PREFIXES',
];

function withSmsEnv(values, fn) {
  const previous = Object.fromEntries(SMS_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SMS_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of SMS_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function failingClient(message = "Could not find the table 'public.sms_send_log'") {
  const result = { data: null, count: null, error: { message } };
  const chain = {
    select() { return this; },
    is() { return this; },
    gte() { return this; },
    lte() { return this; },
    eq() { return this; },
    insert() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return { from: () => chain };
}

const quietLogger = () => ({ error() {}, warn() {} });

test('a missing counter table falls back locally instead of blocking every OTP', async () => {
  await withSmsEnv({}, async () => {
    const guard = createSmsGuard({ client: failingClient(), logger: quietLogger() });
    const verdict = await guard.guardSms({
      phone: '+263771234567',
      ip: '198.51.100.10',
      purpose: 'signup_otp',
    });

    assert.equal(verdict.allowed, true);
    assert.equal(verdict.degraded, true);
  });
});

test('degraded mode uses a stricter per-process global ceiling', async () => {
  await withSmsEnv({
    SMS_MAX_PER_PHONE_HOUR: '10',
    SMS_MAX_PER_PHONE_DAY: '10',
    SMS_MAX_PER_IP_HOUR: '10',
    SMS_MAX_PER_IP_DAY: '10',
    SMS_MAX_PHONES_PER_IP_DAY: '10',
    SMS_MAX_GLOBAL_DAY: '100',
    SMS_MAX_FALLBACK_GLOBAL_DAY: '2',
  }, async () => {
    const guard = createSmsGuard({ client: failingClient(), logger: quietLogger() });

    for (let sent = 0; sent < 2; sent += 1) {
      const request = {
        phone: `+26377123456${sent}`,
        ip: '198.51.100.10',
        purpose: 'signup_otp',
      };
      const verdict = await guard.guardSms(request);
      assert.equal(verdict.allowed, true);
      await guard.recordSmsSent({ ...request, reservationId: verdict.reservationId });
    }

    const blocked = await guard.guardSms({
      phone: '+263771234569',
      ip: '198.51.100.10',
      purpose: 'signup_otp',
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'global_day');
  });
});

test('provider failures do not consume the successful-send quota', async () => {
  await withSmsEnv({ SMS_MAX_PER_PHONE_HOUR: '3' }, async () => {
    const guard = createSmsGuard({ client: null, logger: quietLogger() });
    const request = { phone: '+263771234567', ip: '198.51.100.10', purpose: 'signup_otp' };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await guard.guardSms(request)).allowed, true);
      await guard.recordSmsFailure({ ...request, reason: 'provider_failed' });
    }

    assert.equal((await guard.guardSms(request)).allowed, true);
  });
});

test('only provider-accepted messages count toward the phone limit', async () => {
  await withSmsEnv({ SMS_MAX_PER_PHONE_HOUR: '3' }, async () => {
    const guard = createSmsGuard({ client: null, logger: quietLogger() });
    const request = { phone: '+263771234567', ip: '198.51.100.10', purpose: 'signup_otp' };

    for (let sent = 0; sent < 3; sent += 1) {
      assert.equal((await guard.guardSms(request)).allowed, true);
      await guard.recordSmsSent(request);
    }

    assert.deepEqual(await guard.guardSms(request), {
      allowed: false,
      reason: 'phone_hour',
      message: 'Too many verification codes have been requested. Please try again later.',
    });
  });
});

test('concurrent provider calls are reserved before the configured limit can be exceeded', async () => {
  await withSmsEnv({ SMS_MAX_PER_PHONE_HOUR: '3' }, async () => {
    const guard = createSmsGuard({ client: null, logger: quietLogger() });
    const request = { phone: '+263771234567', ip: '198.51.100.10', purpose: 'signup_otp' };

    const verdicts = await Promise.all(Array.from({ length: 10 }, () => guard.guardSms(request)));
    assert.equal(verdicts.filter((verdict) => verdict.allowed).length, 3);
    assert.ok(verdicts.filter((verdict) => !verdict.allowed).every((verdict) => verdict.reason === 'phone_hour'));
  });
});

test('fan-out cap blocks a new recipient but still permits an existing recipient', async () => {
  await withSmsEnv({
    SMS_MAX_PER_PHONE_HOUR: '10',
    SMS_MAX_PER_PHONE_DAY: '10',
    SMS_MAX_PER_IP_HOUR: '10',
    SMS_MAX_PER_IP_DAY: '10',
    SMS_MAX_PHONES_PER_IP_DAY: '2',
  }, async () => {
    const guard = createSmsGuard({ client: null, logger: quietLogger() });
    const base = { ip: '198.51.100.10', purpose: 'signup_otp' };
    await guard.recordSmsSent({ ...base, phone: '+263771111111' });
    await guard.recordSmsSent({ ...base, phone: '+263772222222' });

    assert.equal((await guard.guardSms({ ...base, phone: '+263771111111' })).allowed, true);
    const newRecipient = await guard.guardSms({ ...base, phone: '+263773333333' });
    assert.equal(newRecipient.allowed, false);
    assert.equal(newRecipient.reason, 'ip_fanout');
  });
});
