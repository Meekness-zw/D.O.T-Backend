import assert from 'node:assert/strict';
import { test } from 'node:test';

const { lateCancelAvailableAt, LATE_CANCEL_STATUSES } = await import('../src/lateCancel.js');

const handover = '2026-10-26T10:00:00.000Z';

test('cancellable 60 minutes after the store hands the order over', () => {
  assert.equal(lateCancelAvailableAt('merchant_confirmed', handover), '2026-10-26T11:00:00.000Z');
  assert.equal(lateCancelAvailableAt('in_transit', handover), '2026-10-26T11:00:00.000Z');
});

test('applies only while the courier is carrying the order', () => {
  assert.deepEqual(LATE_CANCEL_STATUSES, ['merchant_confirmed', 'picked_up', 'in_transit']);
  for (const status of ['pending', 'preparing', 'ready', 'assigned', 'courier_arrived', 'delivery_confirmation_pending', 'delivered']) {
    assert.equal(lateCancelAvailableAt(status, handover), null, status);
  }
});

test('no handover on record means no late cancel', () => {
  assert.equal(lateCancelAvailableAt('in_transit', null), null);
  assert.equal(lateCancelAvailableAt('in_transit', 'not a date'), null);
});
