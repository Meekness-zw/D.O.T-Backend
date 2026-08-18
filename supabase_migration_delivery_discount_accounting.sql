-- Makes promo-code accounting explicit on existing databases.
-- orders.delivery_fee remains the full, undiscounted rider-facing fee.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_scope TEXT
  CHECK (discount_scope IS NULL OR discount_scope = 'delivery_fee');
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_delivery_fee NUMERIC(10, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dot_delivery_subsidy NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'delivery_fee'
  CHECK (applies_to = 'delivery_fee');
ALTER TABLE discount_code_redemptions ADD COLUMN IF NOT EXISTS discount_scope TEXT NOT NULL DEFAULT 'delivery_fee'
  CHECK (discount_scope = 'delivery_fee');

UPDATE orders
SET customer_delivery_fee = delivery_fee
WHERE customer_delivery_fee IS NULL;

ALTER TABLE orders ALTER COLUMN customer_delivery_fee SET NOT NULL;

COMMENT ON COLUMN orders.delivery_fee IS
  'Full undiscounted delivery fee used to calculate rider payout; never reduced by a customer promo code.';
COMMENT ON COLUMN orders.customer_delivery_fee IS
  'Delivery charge paid by the customer after a DOT-funded delivery promo.';
COMMENT ON COLUMN orders.dot_delivery_subsidy IS
  'Amount DOT funds so the rider payout remains based on the full delivery_fee.';
COMMENT ON COLUMN orders.discount_amount IS
  'For discount codes, the DOT-funded reduction to customer delivery only; never a rider payout reduction.';
COMMENT ON COLUMN orders.discount_scope IS
  'Explicit scope for discount_amount; promo-code discounts use delivery_fee.';
COMMENT ON COLUMN discount_codes.applies_to IS
  'Promo-code target; constrained to the customer delivery charge.';
COMMENT ON COLUMN discount_code_redemptions.discount_scope IS
  'Meaning of discount_amount; constrained to customer delivery_fee only.';
