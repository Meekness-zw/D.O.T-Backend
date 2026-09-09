/**
 * Money-path tests for tips and umbrella-company payout routing.
 *
 * The fake models the REAL schema, not the code's assumptions: it rejects
 * columns that do not exist, the way PostgREST does. A fake built to mirror
 * the query under test proves only that the query is self-consistent — that
 * is exactly how `user_profiles.roles` shipped green.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

const COLUMNS = {
  couriers: new Set(['id', 'company_id', 'total_earnings', 'total_deliveries', 'account_balance', 'is_online', 'is_verified']),
  courier_companies: new Set(['id', 'name', 'is_active', 'payout_method_type', 'payout_provider',
    'payout_provider_code', 'payout_account_number', 'payout_account_name']),
  courier_payout_methods: new Set(['id', 'courier_id', 'method_type', 'provider', 'provider_code',
    'account_number', 'account_name', 'is_default']),
  wallet_transactions: new Set(['id', 'user_id', 'user_type', 'transaction_type', 'amount',
    'balance_after', 'description', 'reference_id', 'status', 'created_at']),
};
const TX_TYPES = new Set(['deposit','withdrawal','payment','refund','payout','earnings','promo_credit','tip']);

function makeFake(seed = {}) {
  const db = { couriers: [], courier_companies: [], courier_payout_methods: [], wallet_transactions: [], ...seed };
  let seq = 0;
  const q = (table) => {
    const known = COLUMNS[table];
    let rows = db[table].slice();
    const api = {
      select(cols = '*') {
        if (cols !== '*') {
          for (const c of cols.split(',').map((x) => x.trim()).filter(Boolean)) {
            if (!known.has(c)) throw new Error(`column ${table}.${c} does not exist`);
          }
        }
        return api;
      },
      eq(col, val) {
        if (!known.has(col)) throw new Error(`column ${table}.${col} does not exist`);
        rows = rows.filter((r) => r[col] === val); return api;
      },
      order() { return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }),
      insert(vals) {
        for (const c of Object.keys(vals)) {
          if (!known.has(c)) throw new Error(`column ${table}.${c} does not exist`);
        }
        if (table === 'wallet_transactions' && !TX_TYPES.has(vals.transaction_type)) {
          throw new Error(`violates check constraint on transaction_type: ${vals.transaction_type}`);
        }
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...vals };
        db[table].push(row);
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
      update(vals) {
        for (const c of Object.keys(vals)) {
          if (!known.has(c)) throw new Error(`column ${table}.${c} does not exist`);
        }
        return { eq: async (col, val) => {
          db[table].filter((r) => r[col] === val).forEach((r) => Object.assign(r, vals));
          return { error: null };
        } };
      },
      then: undefined,
    };
    return api;
  };
  return { db, client: { from: q } };
}

// The module binds its client at import time, so the client module is mocked
// before orderPaymentSplit is loaded. Run with --experimental-test-module-mocks.
const fake = makeFake();
mock.module('../src/supabaseAdminClient.js', {
  exports: { supabaseAdmin: fake.client },
});
mock.module('../src/walletLedger.js', {
  exports: {
    getWalletBalance: async (userId, type) => {
      const rows = fake.db.wallet_transactions.filter((r) => r.user_id === userId && r.user_type === type);
      return rows.length ? Number(rows[rows.length - 1].balance_after) : 0;
    },
  },
});

const {
  computeCourierDeliveryPayoutUsd, computeSubtotalSplit,
  recordCourierTip, resolveCourierPayoutDestination,
} = await import('../src/orderPaymentSplit.js');

// ── The split itself ────────────────────────────────────────────────────────

test('the documented $4.99 fee splits exactly $4.00 / $0.99', () => {
  assert.equal(computeCourierDeliveryPayoutUsd(4.99), 4.00);
});

test('a tip is never passed through the delivery-fee cut', () => {
  // The whole point of holding the tip in its own column: were a $2 tip added
  // to the fee instead, the courier would lose 20% of it.
  const feeOnly = computeCourierDeliveryPayoutUsd(4.99);
  const ifTipWereFolded = computeCourierDeliveryPayoutUsd(4.99 + 2);
  assert.equal(feeOnly + 2, 6.00);
  assert.ok(ifTipWereFolded < feeOnly + 2, 'folding a tip into the fee would skim it');
});

test('subtotal split returns the merchant their base price', () => {
  const { merchantEarnings, platformCommission } = computeSubtotalSplit(115);
  assert.equal(merchantEarnings, 100);
  assert.equal(platformCommission, 15);
});

// ── Tips ────────────────────────────────────────────────────────────────────

test('a tip credits in full and lands as its own ledger line', async () => {
  fake.db.couriers.push({ id: 'c1', total_earnings: 0, total_deliveries: 3, account_balance: 0 });
  const res = await recordCourierTip({ courierId: 'c1', orderId: 'o1', amount: 2.5, orderNumber: 'A1' });
  assert.equal(res.amount, 2.5);
  const tx = fake.db.wallet_transactions.filter((t) => t.transaction_type === 'tip');
  assert.equal(tx.length, 1);
  assert.equal(tx[0].amount, 2.5);
});

test('a tip does not inflate the delivery count', async () => {
  const courier = fake.db.couriers.find((c) => c.id === 'c1');
  assert.equal(courier.total_deliveries, 3, 'tip must not count as another delivery');
  assert.equal(courier.total_earnings, 2.5);
});

test('crediting the same tip twice is a no-op', async () => {
  const again = await recordCourierTip({ courierId: 'c1', orderId: 'o1', amount: 2.5, orderNumber: 'A1' });
  assert.equal(again.skipped, true);
  assert.equal(fake.db.wallet_transactions.filter((t) => t.transaction_type === 'tip').length, 1);
});

test('a zero or negative tip records nothing', async () => {
  assert.equal(await recordCourierTip({ courierId: 'c1', orderId: 'o2', amount: 0 }), null);
  assert.equal(await recordCourierTip({ courierId: 'c1', orderId: 'o3', amount: -5 }), null);
});

// ── Where the money goes ────────────────────────────────────────────────────

test('an unaffiliated courier is paid their own default method', async () => {
  fake.db.couriers.push({ id: 'solo', company_id: null });
  fake.db.courier_payout_methods.push({
    id: 'pm1', courier_id: 'solo', method_type: 'mobile_money', provider: 'EcoCash',
    account_number: '0771234567', account_name: 'T Moyo', is_default: true,
  });
  const d = await resolveCourierPayoutDestination('solo');
  assert.equal(d.kind, 'courier');
  assert.equal(d.accountNumber, '0771234567');
});

test('a courier under a company is paid through the company', async () => {
  fake.db.couriers.push({ id: 'emp', company_id: 'co1' });
  fake.db.courier_companies.push({
    id: 'co1', name: 'Harare Riders Ltd', is_active: true, payout_method_type: 'bank_account',
    payout_provider: 'NEDBANK', payout_account_number: '1122334455', payout_account_name: 'Harare Riders Ltd',
  });
  // Their own method exists and must be ignored — this is the whole feature.
  fake.db.courier_payout_methods.push({
    id: 'pm2', courier_id: 'emp', method_type: 'mobile_money', provider: 'EcoCash',
    account_number: '0779999999', is_default: true,
  });
  const d = await resolveCourierPayoutDestination('emp');
  assert.equal(d.kind, 'company');
  assert.equal(d.accountNumber, '1122334455');
  assert.equal(d.companyId, 'co1');
});

test('an inactive company blocks payment rather than falling back to the rider', async () => {
  fake.db.couriers.push({ id: 'emp2', company_id: 'co2' });
  fake.db.courier_companies.push({
    id: 'co2', name: 'Dormant Co', is_active: false,
    payout_account_number: '999', payout_method_type: 'bank_account',
  });
  fake.db.courier_payout_methods.push({
    id: 'pm3', courier_id: 'emp2', method_type: 'mobile_money', account_number: '0770000000', is_default: true,
  });
  const d = await resolveCourierPayoutDestination('emp2');
  assert.equal(d.kind, 'blocked');
  assert.equal(d.reason, 'company_inactive');
});

test('a company with no account on file blocks rather than paying the rider', async () => {
  fake.db.couriers.push({ id: 'emp3', company_id: 'co3' });
  fake.db.courier_companies.push({ id: 'co3', name: 'No Bank Co', is_active: true });
  const d = await resolveCourierPayoutDestination('emp3');
  assert.equal(d.kind, 'blocked');
  assert.equal(d.reason, 'company_has_no_payout_method');
});

test('a courier with nowhere to send money blocks', async () => {
  fake.db.couriers.push({ id: 'nomethod', company_id: null });
  const d = await resolveCourierPayoutDestination('nomethod');
  assert.equal(d.kind, 'blocked');
  assert.equal(d.reason, 'no_payout_method');
});
