-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Admin-issued discount codes, entered by the customer at checkout
-- (distinct from the existing automatic store promotions system, which
-- applies without a code). Platform-wide, percent or fixed-amount off,
-- with an optional total-redemption cap and a per-customer use limit.

CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
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
  redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code_customer
  ON discount_code_redemptions(code_id, customer_id);

-- Stamp the applied code + amount directly on the order too, so receipts /
-- order history can show it without joining the redemptions table.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_code_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on discount_codes" ON discount_codes;
CREATE POLICY "Service role full access on discount_codes"
  ON discount_codes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on discount_code_redemptions" ON discount_code_redemptions;
CREATE POLICY "Service role full access on discount_code_redemptions"
  ON discount_code_redemptions FOR ALL USING (true) WITH CHECK (true);
