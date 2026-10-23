import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCourierAccountProfile } from '../src/courierAccountProfile.js';

function fakeClient({ profile = null, user = { id: 'rider', phone: '263771234567' }, readError = null, authError = null, writeError = null } = {}) {
  const writes = [];
  let authLookups = 0;
  const client = {
    from(table) {
      assert.equal(table, 'user_profiles');
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: profile, error: readError }; },
        async upsert(row, options) { writes.push({ row, options }); return { error: writeError }; },
      };
    },
    auth: { admin: { async getUserById(id) { assert.equal(id, 'rider'); authLookups++; return { data: { user }, error: authError }; } } },
  };
  return { client, writes, authLookups: () => authLookups };
}

test('existing profiles are preserved without Auth lookups or writes', async () => {
  const fake = fakeClient({ profile: { id: 'rider' } });
  await ensureCourierAccountProfile(fake.client, 'rider', 'Rider');
  assert.equal(fake.authLookups(), 0);
  assert.deepEqual(fake.writes, []);
});

test('missing profile is recovered using the same authenticated account ID', async () => {
  const fake = fakeClient();
  await ensureCourierAccountProfile(fake.client, 'rider', 'Rider');
  assert.deepEqual(fake.writes, [{ row: { id: 'rider', email: null, phone: '+263771234567', full_name: 'Rider', role: 'courier' }, options: { onConflict: 'id', ignoreDuplicates: true } }]);
});

for (const config of [{ user: null }, { user: { id: 'different-user' } }, { authError: new Error('unavailable') }]) {
  test(`unverified accounts are not recreated: ${JSON.stringify(config)}`, async () => {
    const fake = fakeClient(config);
    await assert.rejects(ensureCourierAccountProfile(fake.client, 'rider', 'Rider'), /could not be linked/);
    assert.deepEqual(fake.writes, []);
  });
}

test('database lookup failures do not trigger account recreation', async () => {
  const fake = fakeClient({ readError: new Error('database unavailable') });
  await assert.rejects(ensureCourierAccountProfile(fake.client, 'rider', 'Rider'), /database unavailable/);
  assert.equal(fake.authLookups(), 0);
  assert.deepEqual(fake.writes, []);
});

test('profile creation failures stop onboarding', async () => {
  const fake = fakeClient({ writeError: new Error('profile insert failed') });
  await assert.rejects(ensureCourierAccountProfile(fake.client, 'rider', 'Rider'), /profile insert failed/);
});
