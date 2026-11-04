/**
 * A password account moving to PIN sign-in, end to end through the real
 * authService + pinAuth code, against a small in-memory stand-in for Supabase.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

process.env.SUPABASE_JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';

const tables = { user_profiles: [], trusted_devices: [] };

// Enough of the supabase-js query builder for authService and pinAuth.
function query(table) {
  const filters = [];
  let op = 'select';
  let payload = null;
  const rows = () => tables[table].filter((row) => filters.every((f) => f(row)));
  const run = () => {
    if (op === 'update') {
      rows().forEach((row) => Object.assign(row, payload));
      return { data: null, error: null };
    }
    if (op === 'delete') {
      const keep = tables[table].filter((row) => !filters.every((f) => f(row)));
      tables[table].length = 0;
      tables[table].push(...keep);
      return { data: null, error: null };
    }
    if (op === 'insert') {
      tables[table].push({ id: `row-${tables[table].length + 1}`, ...payload });
      return { data: null, error: null };
    }
    return { data: rows().map((row) => ({ ...row })), error: null };
  };
  const builder = {
    select: () => builder,
    update: (values) => ((op = 'update'), (payload = values), builder),
    insert: (values) => ((op = 'insert'), (payload = values), builder),
    delete: () => ((op = 'delete'), builder),
    eq: (col, val) => (filters.push((row) => row[col] === val), builder),
    in: (col, vals) => (filters.push((row) => vals.includes(row[col])), builder),
    limit: () => builder,
    single: async () => {
      const { data } = run();
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } };
    },
    maybeSingle: async () => {
      const { data } = run();
      return { data: data[0] || null, error: null };
    },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

mock.module('../src/supabaseAdminClient.js', {
  namedExports: { supabaseAdmin: { from: query } },
});

const { hashPassword } = await import('../src/passwordHash.js');
const { loginWithPassword, findProfileByPhone, findProfileById } = await import('../src/authService.js');
const {
  setAccountPin,
  checkAccountPin,
  issueDeviceToken,
  userForDeviceToken,
  revokeAllDeviceTokens,
  isPinLocked,
} = await import('../src/pinAuth.js');

function addAccount(fields) {
  tables.user_profiles.push({
    is_suspended: false,
    pin_hash: null,
    pin_failed_attempts: 0,
    pin_locked_until: null,
    role: 'customer',
    full_name: 'Test User',
    ...fields,
  });
}

test('a password account signs in with its password once, then only with its PIN', async () => {
  addAccount({ id: 'u1', phone: '+263771111111', email: 'a@example.com', password_hash: hashPassword('Old-pass1!') });

  // Before a PIN: the old password still works, and that's the way in.
  const first = await loginWithPassword({ phone: '+263771111111', password: 'Old-pass1!' });
  assert.equal(first.user.id, 'u1');
  assert.ok(first.session.access_token);

  // They choose a PIN on this phone, which becomes trusted.
  await setAccountPin('u1', '4827');
  const deviceToken = await issueDeviceToken('u1', 'device');
  assert.equal(await userForDeviceToken(deviceToken, 'device'), 'u1');

  // From now on the password is refused, with the message the app shows.
  await assert.rejects(
    loginWithPassword({ phone: '+263771111111', password: 'Old-pass1!' }),
    /signs in with a PIN/,
  );

  // And the PIN is what works.
  const profile = await findProfileById('u1');
  assert.deepEqual(await checkAccountPin(profile, '4827'), { ok: true });
});

test('accounts stored with a local 07… number are found from the +263 number', async () => {
  addAccount({ id: 'u2', phone: '0772222222', email: null, password_hash: hashPassword('Old-pass2!') });
  const profile = await findProfileByPhone('+263772222222');
  assert.equal(profile?.id, 'u2');
  // No email: the app must not offer an emailed code to this account.
  assert.equal(profile.email, null);
  const signedIn = await loginWithPassword({ phone: '+263772222222', password: 'Old-pass2!' });
  assert.equal(signedIn.user.id, 'u2');
});

test('a wrong old password is reported as such, not as a missing account', async () => {
  await assert.rejects(
    loginWithPassword({ phone: '+263772222222', password: 'nope' }),
    /Incorrect phone or password/,
  );
  await assert.rejects(
    loginWithPassword({ phone: '+263779999999', password: 'nope' }),
    /No account found/,
  );
});

test('a device token only signs in as its own account and kind', async () => {
  const token = await issueDeviceToken('u2', 'device');
  assert.equal(await userForDeviceToken(token, 'device'), 'u2');
  assert.equal(await userForDeviceToken(token, 'biometric'), null);
  assert.equal(await userForDeviceToken('made-up', 'device'), null);
  assert.equal(await userForDeviceToken(undefined, 'device'), null);
});

test('five wrong PINs lock it; a reset unlocks it and forgets old devices', async () => {
  let profile = await findProfileById('u1');
  for (let i = 0; i < 4; i++) {
    const result = await checkAccountPin(profile, '0000');
    assert.equal(result.ok, false);
    profile = await findProfileById('u1');
  }
  assert.deepEqual(await checkAccountPin(profile, '0000'), { ok: false, locked: true });
  profile = await findProfileById('u1');
  assert.ok(isPinLocked(profile));
  // Even the right PIN is refused while locked.
  assert.deepEqual(await checkAccountPin(profile, '4827'), { ok: false, locked: true });

  // What /auth/pin/reset does after the emailed code checks out.
  const before = tables.trusted_devices.filter((d) => d.user_id === 'u1').length;
  assert.ok(before > 0);
  await setAccountPin('u1', '5938');
  await revokeAllDeviceTokens('u1');
  assert.equal(tables.trusted_devices.filter((d) => d.user_id === 'u1').length, 0);
  profile = await findProfileById('u1');
  assert.equal(isPinLocked(profile), false);
  assert.deepEqual(await checkAccountPin(profile, '5938'), { ok: true });
});

test('a frozen account is refused even with the right password', async () => {
  addAccount({ id: 'u3', phone: '+263773333333', email: 'c@example.com', password_hash: hashPassword('Old-pass3!'), is_suspended: true });
  await assert.rejects(
    loginWithPassword({ phone: '+263773333333', password: 'Old-pass3!' }),
    /frozen/,
  );
});
