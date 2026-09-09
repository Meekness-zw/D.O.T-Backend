/**
 * The breakdown must add up to what the customer was charged. If it does not,
 * somebody is being paid money that was never collected — or is not being
 * paid money that was.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

mock.module('../src/supabaseAdminClient.js', { exports: { supabaseAdmin: null } });
process.env.PLATFORM_MARKUP_RATE = '0.15';
process.env.DELIVERY_PLATFORM_CUT_RATE = '0.2';

const { settlementForOrder, reconcile } = await import('../src/settlementService.js');

const order = (over = {}) => ({
  id: 'o1', order_number: 'DOT-1', store_id: 's1', courier_id: 'c1',
  subtotal: 115, delivery_fee: 4.99, customer_delivery_fee: 4.99,
  dot_delivery_subsidy: 0, tax: 0, courier_tip: 0,
  store: { merchant_id: 'm1', store_name: 'Test Store' },
  ...over,
});

test('a plain order splits into the documented shares', () => {
  const s = settlementForOrder(order());
  assert.equal(s.store.amount_due, 100);       // merchant's own base price
  assert.equal(s.store.dot_markup, 15);        // the 15% added for the customer
  assert.equal(s.courier.amount_due, 4.00);    // $4.99 fee less DOT's 20%
  assert.equal(s.dot.net, 15.99);
  assert.equal(s.customer_paid, 119.99);
});

test('a plain order reconciles', () => {
  const r = reconcile(settlementForOrder(order()));
  assert.ok(r.balanced, `distributed ${r.distributed} vs charged ${r.charged}`);
});

test('a tip goes to the courier whole and is charged to the customer', () => {
  const s = settlementForOrder(order({ courier_tip: 3 }));
  assert.equal(s.courier.tip, 3);
  assert.equal(s.courier.amount_due, 7.00);          // 4.00 fee share + 3.00 tip
  assert.equal(s.dot.net, 15.99, 'DOT takes nothing from a tip');
  assert.equal(s.customer_paid, 122.99);
  assert.ok(reconcile(s).balanced);
});

test('a promo-subsidised order reconciles', () => {
  // DOT funded $2 of the delivery fee: the courier is still paid on the full
  // fee, and the customer was charged $2 less.
  const s = settlementForOrder(order({ customer_delivery_fee: 2.99, dot_delivery_subsidy: 2 }));
  assert.equal(s.courier.amount_due, 4.00, 'a promo must not come out of the rider');
  assert.equal(s.dot.net, 13.99, 'DOT absorbs the subsidy');
  assert.equal(s.customer_paid, 117.99);
  const r = reconcile(s);
  assert.ok(r.balanced, `distributed ${r.distributed} vs charged ${r.charged}`);
});

test('tax is passed through, not distributed to anyone', () => {
  const s = settlementForOrder(order({ tax: 5 }));
  assert.equal(s.customer_paid, 124.99);
  assert.ok(reconcile(s).balanced);
});

test('a fully subsidised delivery can push DOT net negative, and still reconciles', () => {
  const s = settlementForOrder(order({ subtotal: 11.5, customer_delivery_fee: 0, dot_delivery_subsidy: 4.99 }));
  assert.equal(s.courier.amount_due, 4.00);
  assert.ok(s.dot.net < 0, 'DOT bought this order; that should show as a loss');
  assert.ok(reconcile(s).balanced);
});
