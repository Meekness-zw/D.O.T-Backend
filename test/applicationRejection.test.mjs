import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const events = [];

function makeDatabase() {
  return {
    user_profiles: [],
    user_roles: [],
    customers: [],
    merchants: [],
    couriers: [],
  };
}

const db = makeDatabase();

function resetDatabase(seed = {}) {
  for (const table of Object.keys(db)) {
    db[table].splice(0, db[table].length, ...(seed[table] || []).map((row) => ({ ...row })));
  }
  events.length = 0;
}

function makeQuery(table) {
  let operation = 'select';
  let values = null;
  let returning = false;
  const filters = [];

  const matches = (row) => filters.every(([column, value]) => row[column] === value);
  const withRelations = (row) => {
    const copy = { ...row };
    if (table === 'merchants' || table === 'couriers') {
      const profile = db.user_profiles.find((candidate) => candidate.id === row.id);
      copy.user_profiles = profile ? { ...profile } : null;
    }
    return copy;
  };

  const execute = () => {
    if (operation === 'select') {
      return { data: db[table].filter(matches).map(withRelations), error: null };
    }

    if (operation === 'update') {
      const rows = db[table].filter(matches);
      rows.forEach((row) => Object.assign(row, values));
      return { data: returning ? rows.map(withRelations) : null, error: null };
    }

    if (operation === 'delete') {
      const deleted = db[table].filter(matches);
      db[table] = db[table].filter((row) => !matches(row));
      return { data: returning ? deleted.map(withRelations) : null, error: null };
    }

    throw new Error(`Unsupported fake operation: ${operation}`);
  };

  const query = {
    select() {
      if (operation === 'delete' || operation === 'update') returning = true;
      return query;
    },
    eq(column, value) {
      filters.push([column, value]);
      return query;
    },
    update(nextValues) {
      operation = 'update';
      values = nextValues;
      return query;
    },
    delete() {
      operation = 'delete';
      return query;
    },
    upsert(row) {
      const existing = db[table].find((candidate) => (
        table === 'user_roles'
          ? candidate.user_id === row.user_id && candidate.role === row.role
          : candidate.id === row.id
      ));
      if (existing) Object.assign(existing, row);
      else db[table].push({ ...row });
      return Promise.resolve({ data: row, error: null });
    },
    async maybeSingle() {
      const result = execute();
      return { data: result.data?.[0] || null, error: result.error };
    },
    then(resolve, reject) {
      return Promise.resolve(execute()).then(resolve, reject);
    },
  };

  return query;
}

const fakeSupabase = {
  from: (table) => makeQuery(table),
  auth: {
    admin: {
      async deleteUser(userId) {
        events.push({ type: 'auth-delete', userId });
        for (const table of ['user_profiles', 'customers', 'merchants', 'couriers']) {
          db[table] = db[table].filter((row) => row.id !== userId);
        }
        db.user_roles = db.user_roles.filter((row) => row.user_id !== userId);
        return { error: null };
      },
    },
  },
};

mock.module('../src/supabaseAdminClient.js', {
  exports: { supabaseAdmin: fakeSupabase },
});

mock.module('axios', {
  defaultExport: {
    async post(_url, payload) {
      events.push({ type: 'push', payload });
      return { data: { status: 'ok' } };
    },
  },
});

const { rejectCourier, rejectMerchant } = await import('../src/adminService.js');

beforeEach(() => resetDatabase());

test('rejecting a merchant-only signup notifies first and hard-deletes the account', async () => {
  resetDatabase({
    user_profiles: [{
      id: 'merchant-only', role: 'merchant', push_role: 'merchant',
      push_token: 'ExponentPushToken[merchant-only]', full_name: 'Merchant Owner',
    }],
    user_roles: [{ user_id: 'merchant-only', role: 'merchant' }],
    merchants: [{
      id: 'merchant-only', business_name: 'Pending Store', business_type: 'Grocery',
      approval_status: 'pending',
    }],
  });

  const result = await rejectMerchant('merchant-only', 'Documents are unreadable');

  assert.equal(result.deleted, true);
  assert.equal(result.deletion_scope, 'account');
  assert.deepEqual(result.remaining_roles, []);
  assert.equal(result.rejection_reason, 'Documents are unreadable');
  assert.deepEqual(events.map((event) => event.type), ['push', 'auth-delete']);
  assert.equal(events[0].payload.data.reason, 'Documents are unreadable');
  assert.equal(db.user_profiles.length, 0);
  assert.equal(db.merchants.length, 0);
  assert.equal(db.user_roles.length, 0);
});

test('rejecting a courier-only signup sends the push even while the courier is offline', async () => {
  resetDatabase({
    user_profiles: [{
      id: 'courier-only', role: 'courier', push_role: 'courier',
      push_token: 'ExponentPushToken[courier-only]', full_name: 'Pending Rider',
    }],
    couriers: [{ id: 'courier-only', verification_status: 'pending', is_online: false }],
  });

  const result = await rejectCourier('courier-only', 'Licence has expired');

  assert.equal(result.deletion_scope, 'account');
  assert.deepEqual(events.map((event) => event.type), ['push', 'auth-delete']);
  assert.equal(events[0].payload.data.reason, 'Licence has expired');
  assert.equal(db.couriers.length, 0);
});

test('rejecting one role preserves a multi-role account and switches primary and push roles', async () => {
  resetDatabase({
    user_profiles: [{
      id: 'multi', role: 'merchant', push_role: 'merchant',
      push_token: 'ExponentPushToken[multi]', full_name: 'Multi Role User',
    }],
    user_roles: [
      { user_id: 'multi', role: 'customer' },
      { user_id: 'multi', role: 'merchant' },
      { user_id: 'multi', role: 'courier' },
    ],
    customers: [{ id: 'multi' }],
    merchants: [{ id: 'multi', business_name: 'No Thanks', approval_status: 'pending' }],
    couriers: [{ id: 'multi', verification_status: 'approved' }],
  });

  const result = await rejectMerchant('multi', 'Application does not meet the standard');

  assert.equal(result.deletion_scope, 'role');
  assert.deepEqual(result.remaining_roles, ['customer', 'courier']);
  assert.deepEqual(events.map((event) => event.type), ['push']);
  assert.equal(db.user_profiles[0].role, 'customer');
  assert.equal(db.user_profiles[0].push_role, 'customer');
  assert.equal(db.merchants.length, 0);
  assert.equal(db.customers.length, 1);
  assert.equal(db.couriers.length, 1);
  assert.deepEqual(db.user_roles.map((row) => row.role).sort(), ['courier', 'customer']);
});

test('an approved application cannot be deleted through the rejection endpoint', async () => {
  resetDatabase({
    user_profiles: [{ id: 'approved', role: 'merchant', push_role: 'merchant' }],
    merchants: [{ id: 'approved', business_name: 'Live Store', approval_status: 'approved' }],
  });

  await assert.rejects(
    rejectMerchant('approved', 'mistake'),
    (error) => error.status === 409 && /approved merchant/i.test(error.message),
  );

  assert.equal(db.merchants.length, 1);
  assert.deepEqual(events, []);
});
