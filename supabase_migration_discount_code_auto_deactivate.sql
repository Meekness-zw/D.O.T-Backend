-- Run in Supabase SQL Editor after supabase_migration_discount_codes.sql.
--
-- Auto-deactivates a discount code the moment its redemption count reaches
-- max_redemptions, so exhausted codes stop showing as "Active" in the admin
-- dashboard instead of silently becoming unusable while still looking live.
-- Covers both a one-time code (max_redemptions = 1) and a multi-use/
-- influencer code (max_redemptions = X) with the same logic. Runs inside the
-- same row lock as the rest of redeem_discount_code, so it can't race with a
-- concurrent redemption of the same code.

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

  -- This redemption just consumed the last available slot — retire the code.
  IF v_code.max_redemptions IS NOT NULL AND (COALESCE(v_total_uses, 0) + 1) >= v_code.max_redemptions THEN
    UPDATE discount_codes SET is_active = FALSE WHERE id = p_code_id;
  END IF;

  RETURN v_result;
END;
$$;
