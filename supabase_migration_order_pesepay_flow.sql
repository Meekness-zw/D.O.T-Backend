-- Order + Pesepay: awaiting_payment status, payment methods, commission columns, Realtime.
-- Run in Supabase SQL editor after reviewing existing constraints.

-- 1) Order status: add awaiting_payment (customer paid online but webhook not confirmed yet — actually we use awaiting_payment BEFORE pay; after pay -> pending)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'awaiting_payment',
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'assigned',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
  'refunded'
));

-- 2) Payment method: wallet + pesepay (server already used wallet; schema may differ per env)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (
  payment_method IN ('card', 'mobile_money', 'cash', 'wallet', 'pesepay')
);

-- 3) Commission snapshot (MVP internal accounting)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_commission_amount DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_earnings_amount DECIMAL(10, 2) DEFAULT 0;

COMMENT ON COLUMN orders.platform_commission_amount IS 'Platform take from order subtotal (see PLATFORM_COMMISSION_RATE on backend)';
COMMENT ON COLUMN orders.merchant_earnings_amount IS 'Merchant portion of subtotal after platform commission';

-- 4) Realtime: allow clients to subscribe to order row updates (payment_status, status).
-- If this errors with "already exists", the table is already in the publication — safe to ignore.
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
