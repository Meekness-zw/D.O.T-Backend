/**
 * Delivery fee: $5.00 up to 10 km, then $0.25 per km by the actual distance
 * (to 0.1 km), never more than $6.25 (15 km, the furthest a store delivers).
 * DOT keeps 20% ($1.00 of the base), the courier the rest.
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

mock.module('../src/supabaseAdminClient.js', { namedExports: { supabaseAdmin: null } });
process.env.DELIVERY_PLATFORM_CUT_RATE = '0.2';
delete process.env.MAX_DELIVERY_FEE_USD;

const { calculateDeliveryFee, deliveryFeeQuote, deliveryBreakdownForOrder, storeDeliveryRadiusKm } = await import('../src/deliveryFee.js');

test('$5.00 for anything up to 10 km', () => {
  assert.equal(calculateDeliveryFee(0), 5);
  assert.equal(calculateDeliveryFee(4.2), 5);
  assert.equal(calculateDeliveryFee(10), 5);
  // 10.04 km is shown as 10.0 km, so it's still the base.
  assert.equal(calculateDeliveryFee(10.04), 5);
});

test('$0.25 per km beyond 10, by the part of a km travelled', () => {
  assert.equal(calculateDeliveryFee(10.5), 5.13); // 5 + 0.5 × 0.25 = 5.125
  assert.equal(calculateDeliveryFee(10.3), 5.08); // 5.075, rounded up, not down
  assert.equal(calculateDeliveryFee(11), 5.25);
  assert.equal(calculateDeliveryFee(12.7), 5.68);
  assert.equal(calculateDeliveryFee(15), 6.25);
  const q = deliveryFeeQuote(10.5);
  assert.equal(q.extra_km, 0.5);
  assert.equal(q.distance_charge, 0.13);
});

test('never more than $6.25', () => {
  assert.equal(calculateDeliveryFee(22), 6.25);
  const q = deliveryFeeQuote(22);
  assert.equal(q.capped, true);
  assert.equal(q.uncapped_fee, 8);
});

test('base trip: courier $4.00, DOT $1.00', () => {
  const b = deliveryBreakdownForOrder({ delivery_fee: 5 });
  assert.equal(b.courier_share, 4);
  assert.equal(b.dot_cut, 1);
  assert.equal(b.dot_cut_on_base, 1);
  assert.equal(b.dot_cut_on_distance, 0);
});

test('15 km trip: courier $5.00, DOT $1.25 of which $1.00 is on the base', () => {
  const b = deliveryBreakdownForOrder({ delivery_fee: 6.25, customer_delivery_fee: 6.25 });
  assert.equal(b.base_fee + b.distance_charge, 6.25);
  assert.equal(b.courier_share, 5);
  assert.equal(b.dot_cut, 1.25);
  assert.equal(b.dot_cut_on_base + b.dot_cut_on_distance, b.dot_cut);
});

test('an order priced under the old rules is flagged, not re-priced', () => {
  // Harare CBD to ~20 km out, charged $8 under the old cap.
  const b = deliveryBreakdownForOrder({
    delivery_fee: 8,
    pickup_latitude: -17.8292, pickup_longitude: 31.0522,
    delivery_latitude: -17.65, delivery_longitude: 31.05,
  });
  assert.equal(b.fee_charged, 8);
  assert.equal(b.priced_by_current_rules, false);
  assert.equal(b.current_rules_fee, 6.25);
});

test('a store delivers up to its own radius, never past 15 km', () => {
  assert.equal(storeDeliveryRadiusKm({ delivery_radius_km: 5 }), 5);
  assert.equal(storeDeliveryRadiusKm({ delivery_radius_km: 40 }), 15);
  assert.equal(storeDeliveryRadiusKm({}), 15);
});
