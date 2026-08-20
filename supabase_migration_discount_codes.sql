-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Admin-issued discount codes, entered by the customer at checkout
-- (distinct from the existing automatic store promotions system, which
-- applies without a code). Platform-wide, percent or fixed-amount off the
-- CUSTOMER'S DELIVERY CHARGE ONLY. The rider-facing delivery_fee is unchanged,
-- with an optional total-redemption cap and a per-customer use limit.

CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  applies_to TEXT NOT NULL DEFAULT 'delivery_fee' CHECK (applies_to = 'delivery_fee'),
  value NUMERIC(10, 2) NOT NULL CHECK (value > 0),
  -- Percent codes are capped at 100; fixed codes are capped per-order at checkout time.
  max_redemptions INTEGER, -- NULL = unlimited total uses across all customers
  per_customer_limit INTEGER NOT NULL DEFAULT 1, -- how many times ONE customer may use it
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMP WITH TIME ZONE, -- NULL = never expires
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(UPPER(code));

CREATE TABLE IF NOT EXISTS discount_code_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  discount_amount NUMERIC(10, 2) NOT NULL,
  discount_scope TEXT NOT NULL DEFAULT 'delivery_fee' CHECK (discount_scope = 'delivery_fee'),
  redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code_customer
  ON discount_code_redemptions(code_id, customer_id);

-- Safe to (re-)run even if discount_codes/discount_code_redemptions already
-- existed before `applies_to`/`discount_scope` were added to the CREATE
-- TABLE statements above — CREATE TABLE IF NOT EXISTS is a no-op on an
-- existing table, it does NOT add new columns to it.
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'delivery_fee'
  CHECK (applies_to = 'delivery_fee');
ALTER TABLE discount_code_redemptions ADD COLUMN IF NOT EXISTS discount_scope TEXT NOT NULL DEFAULT 'delivery_fee'
  CHECK (discount_scope = 'delivery_fee');

-- Stamp the applied code + amount directly on the order too, so receipts /
-- order history can show it without joining the redemptions table.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_scope TEXT
  CHECK (discount_scope IS NULL OR discount_scope = 'delivery_fee');
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_delivery_fee NUMERIC(10, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dot_delivery_subsidy NUMERIC(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN orders.delivery_fee IS
  'Full undiscounted delivery fee used to calculate rider payout; never reduced by a customer promo code.';
COMMENT ON COLUMN orders.customer_delivery_fee IS
  'Delivery charge paid by the customer after a DOT-funded delivery promo.';
COMMENT ON COLUMN orders.dot_delivery_subsidy IS
  'Amount DOT funds so the rider payout remains based on the full delivery_fee.';
COMMENT ON COLUMN orders.discount_amount IS
  'Legacy/general display amount; for discount codes this equals dot_delivery_subsidy and applies only to delivery.';
COMMENT ON COLUMN orders.discount_scope IS
  'Explicit scope for promo discount_amount; currently only delivery_fee is allowed.';
COMMENT ON COLUMN discount_codes.applies_to IS
  'Promo-code target; constrained to the customer delivery charge.';
COMMENT ON COLUMN discount_code_redemptions.discount_scope IS
  'Meaning of discount_amount; constrained to customer delivery_fee only.';

ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_code_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on discount_codes" ON discount_codes;
CREATE POLICY "Service role full access on discount_codes"
  ON discount_codes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on discount_code_redemptions" ON discount_code_redemptions;
CREATE POLICY "Service role full access on discount_code_redemptions"
  ON discount_code_redemptions FOR ALL USING (true) WITH CHECK (true);

-- Atomic redemption: the app calls this via supabase.rpc(...) instead of a
-- plain INSERT so that concurrent checkouts using the same code (near
-- max_redemptions, or the same customer submitting two orders at once) can't
-- both pass a check-then-act race and exceed the code's limits. The
-- `FOR UPDATE` row lock on discount_codes serializes concurrent callers for
-- the same code — the second caller re-reads the redemption counts fresh
-- after the first one commits, instead of both reading stale counts.
CREATE OR REPLACE FUNCTION redeem_discount_code(
  p_code_id UUID,
  p_customer_id UUID,
  p_order_id UUID,
  p_discount_amount NUMERIC
) RETURNS discount_code_redemptions
LANGUAGE plpgsql
AS $$
DECLARE
  v_code discount_codes%ROWTYPE;
  v_total_uses INTEGER;
  v_customer_uses INTEGER;
  v_result discount_code_redemptions%ROWTYPE;
BEGIN
  SELECT * INTO v_code FROM discount_codes WHERE id = p_code_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'discount code not found';
  END IF;
  IF NOT v_code.is_active THEN
    RAISE EXCEPTION 'code inactive';
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at < NOW() THEN
    RAISE EXCEPTION 'code expired';
  END IF;

  IF v_code.max_redemptions IS NOT NULL THEN
    SELECT COUNT(*) INTO v_total_uses FROM discount_code_redemptions WHERE code_id = p_code_id;
    IF v_total_uses >= v_code.max_redemptions THEN
      RAISE EXCEPTION 'max redemptions reached';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_customer_uses
    FROM discount_code_redemptions
    WHERE code_id = p_code_id AND customer_id = p_customer_id;
  IF v_customer_uses >= COALESCE(v_code.per_customer_limit, 1) THEN
    RAISE EXCEPTION 'per customer limit reached';
  END IF;

  INSERT INTO discount_code_redemptions (code_id, customer_id, order_id, discount_amount)
  VALUES (p_code_id, p_customer_id, p_order_id, p_discount_amount)
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;
