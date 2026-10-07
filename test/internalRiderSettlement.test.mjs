import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDotPaidCourier, settlementForOrder } from '../src/settlementService.js';

test('an internal rider job keeps the delivery share with DOT and still reconciles', () => {
  const settlement = settlementForOrder({
    id: 'order-1',
    order_number: '1001',
    subtotal: 10,
    delivery_fee: 4.99,
    customer_delivery_fee: 4.99,
    dot_delivery_subsidy: 0,
    tax: 0,
    courier_id: 'rider-1',
    store_id: 'store-1',
    status: 'delivered',
    payment_status: 'paid',
    payment_method: 'mobile_money',
  });

  const before = settlement.dot.net;
  applyDotPaidCourier(settlement);

  assert.equal(settlement.courier.amount_due, 0);
  assert.equal(settlement.courier.paid_by_dot, true);
  assert.equal(settlement.dot.net, Math.round((before + 4) * 100) / 100);
  assert.equal(settlement.reconciliation.balanced, true);
});
