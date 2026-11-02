import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// Records user_profiles updates instead of touching the database.
const updates = [];
mock.module('../src/supabaseAdminClient.js', {
  namedExports: {
    supabaseAdmin: {
      from: () => ({
        update: (values) => ({
          eq: async () => {
            updates.push(values);
            return { error: null };
          },
        }),
      }),
    },
  },
});

const {
  pinProblem,
  hashPin,
  isPinLocked,
  checkAccountPin,
  createEmailCode,
  checkEmailCode,
  consumeEmailCode,
  PIN_MAX_ATTEMPTS,
} = await import('../src/pinAuth.js');

test('a PIN is exactly four digits and not an obvious one', () => {
  assert.equal(pinProblem('4827'), null);
  assert.equal(pinProblem('0582'), null);
  for (const bad of ['123', '12345', 'abcd', '', null, '12 4']) assert.ok(pinProblem(bad), String(bad));
  for (const obvious of ['0000', '7777', '1234', '6789', '4321', '9876']) assert.ok(pinProblem(obvious), obvious);
});

test('wrong PINs count down and lock on the fifth', async () => {
  const profile = { id: 'u1', pin_hash: hashPin('4827'), pin_failed_attempts: 0 };
  updates.length = 0;
  const first = await checkAccountPin(profile, '1111');
  assert.deepEqual(first, { ok: false, attemptsLeft: PIN_MAX_ATTEMPTS - 1 });

  const last = await checkAccountPin({ ...profile, pin_failed_attempts: PIN_MAX_ATTEMPTS - 1 }, '1111');
  assert.deepEqual(last, { ok: false, locked: true });
  assert.ok(isPinLocked({ pin_locked_until: updates.at(-1).pin_locked_until }));
});

test('a locked PIN is refused even when it is right', async () => {
  const profile = { id: 'u1', pin_hash: hashPin('4827'), pin_locked_until: '2999-01-01T00:00:00Z' };
  assert.deepEqual(await checkAccountPin(profile, '4827'), { ok: false, locked: true });
});

test('the right PIN clears earlier failures', async () => {
  updates.length = 0;
  const profile = { id: 'u1', pin_hash: hashPin('4827'), pin_failed_attempts: 3 };
  assert.deepEqual(await checkAccountPin(profile, '4827'), { ok: true });
  assert.deepEqual(updates, [{ pin_failed_attempts: 0 }]);
});

test('emailed codes are tied to their purpose and survive a failed PIN step', () => {
  const code = createEmailCode('u2', 'new-device');
  assert.equal(checkEmailCode('u2', 'pin-reset', code).ok, false);
  assert.equal(checkEmailCode('u2', 'new-device', code).ok, true);
  // Still usable until consumed (the PIN after it may have been mistyped).
  assert.equal(checkEmailCode('u2', 'new-device', code).ok, true);
  consumeEmailCode('u2');
  assert.equal(checkEmailCode('u2', 'new-device', code).ok, false);
});

test('five wrong codes discard the code', () => {
  const code = createEmailCode('u3', 'pin-reset');
  for (let i = 0; i < 4; i++) assert.equal(checkEmailCode('u3', 'pin-reset', '000000').status, 400);
  assert.equal(checkEmailCode('u3', 'pin-reset', '000000').status, 429);
  assert.equal(checkEmailCode('u3', 'pin-reset', code).ok, false);
});
