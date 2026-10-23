/**
 * Delivery fee: $4.99 within 5 km, $0.50 per started km after that, never
 * more than $8. DOT keeps 20% ($0.99 of the base), the courier the rest.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

mock.module('../src/supabaseAdminClient.js', { namedExports: { supabaseAdmin: null } });
process.env.DELIVERY_PLATFORM_CUT_RATE = '0.2';
delete process.env.MAX_DELIVERY_FEE_USD;

const { calculateDeliveryFee, deliveryFeeQuote, deliveryBreakdownForOrder } = await import('../src/deliveryFee.js');

test('base fee within 5 km', () => {
  assert.equal(calculateDeliveryFee(0), 4.99);
  assert.equal(calculateDeliveryFee(5), 4.99);
});

test('$0.50 for every started km beyond 5', () => {
  assert.equal(calculateDeliveryFee(5.1), 5.49);
  assert.equal(calculateDeliveryFee(8), 6.49);
});

test('never more than $8', () => {
  // 11 km would be $4.99 + 6 × $0.50 = $7.99 — just under the cap.
  assert.equal(calculateDeliveryFee(11), 7.99);
  assert.equal(calculateDeliveryFee(12), 8);
  assert.equal(calculateDeliveryFee(40), 8);
  const q = deliveryFeeQuote(40);
  assert.equal(q.capped, true);
  assert.equal(q.uncapped_fee, 22.49);
});

test('base trip: courier $4.00, DOT $0.99', () => {
  const b = deliveryBreakdownForOrder({ delivery_fee: 4.99 });
  assert.equal(b.courier_share, 4);
  assert.equal(b.dot_cut, 0.99);
  assert.equal(b.dot_cut_on_base, 0.99);
  assert.equal(b.dot_cut_on_distance, 0);
});

test('capped trip: courier $6.40, DOT $1.60 of which $0.99 is on the base', () => {
  // Harare CBD to ~20 km out.
  const b = deliveryBreakdownForOrder({
    delivery_fee: 8, customer_delivery_fee: 8,
    pickup_latitude: -17.8292, pickup_longitude: 31.0522,
    delivery_latitude: -17.65, delivery_longitude: 31.05,
  });
  assert.equal(b.capped, true);
  assert.ok(b.cap_saving > 0);
  assert.equal(b.base_fee + b.distance_charge, 8);
  assert.equal(b.courier_share, 6.4);
  assert.equal(b.dot_cut, 1.6);
  assert.equal(b.dot_cut_on_base + b.dot_cut_on_distance, b.dot_cut);
  assert.equal(b.priced_by_current_rules, true);
});

test('an order priced before the cap is flagged, not re-priced', () => {
  const b = deliveryBreakdownForOrder({
    delivery_fee: 12.49,
    pickup_latitude: -17.8292, pickup_longitude: 31.0522,
    delivery_latitude: -17.65, delivery_longitude: 31.05,
  });
  assert.equal(b.fee_charged, 12.49);
  assert.equal(b.priced_by_current_rules, false);
  assert.equal(b.current_rules_fee, 8);
  assert.equal(b.capped, false);
});
