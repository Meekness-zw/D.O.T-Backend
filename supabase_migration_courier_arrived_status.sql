-- Add 'courier_arrived' to the orders status CHECK constraint.
-- This status is set when the courier taps "Arrived for Pickup" and signals
-- the merchant that the courier is physically at the store waiting for handoff.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending',
  'awaiting_payment',
  'confirmed',
  'preparing',
  'ready',
  'assigned',
  'courier_arrived',
  'merchant_confirmed',
  'picked_up',
  'in_transit',
  'delivery_confirmation_pending',
  'delivered',
  'cancelled'
));
