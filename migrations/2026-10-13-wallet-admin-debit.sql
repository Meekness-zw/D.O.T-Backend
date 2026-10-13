-- Run in the Supabase SQL editor, then: NOTIFY pgrst, 'reload schema';
--
-- Lets the admin dashboard show each user's wallet balance and deduct from it.
-- Run this after supabase_migration_wallet_promo_credit.sql. It replaces the
-- transaction-type list, and promo_credit has to stay in that list.
-- admin_debit is a DOT clawback, not a customer withdrawal.

COMMENT ON COLUMN wallet_transactions.transaction_type IS
  'promo_credit = admin-issued promotional balance, funded by DOT. admin_debit = amount taken back by DOT. Neither is the customer''s own deposit.';

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_transaction_type_check;

ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'deposit', 'withdrawal', 'payment', 'refund', 'payout', 'earnings',
    'promo_credit', 'admin_debit'
  ));

-- Latest balance for each wallet on the given accounts. One row per
-- user and wallet type, so the users page does not scan every transaction.
CREATE OR REPLACE FUNCTION admin_wallet_balances(p_user_ids UUID[])
RETURNS TABLE(user_id UUID, user_type TEXT, balance_after NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (wt.user_id, wt.user_type)
    wt.user_id,
    wt.user_type,
    wt.balance_after
  FROM wallet_transactions wt
  WHERE wt.user_id = ANY(p_user_ids)
  ORDER BY wt.user_id, wt.user_type, wt.created_at DESC, wt.id DESC;
$$;

REVOKE ALL ON FUNCTION admin_wallet_balances(UUID[]) FROM PUBLIC, anon, authenticated;

-- Same advisory lock as credit_customer_wallet for a customer wallet, so a
-- credit and a debit on that wallet cannot both read the same balance.
CREATE OR REPLACE FUNCTION debit_wallet(
  p_user_id UUID,
  p_user_type TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_reference_id UUID DEFAULT NULL
)
RETURNS wallet_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev NUMERIC;
  v_row  wallet_transactions;
BEGIN
  IF p_user_type NOT IN ('customer', 'merchant', 'courier') THEN
    RAISE EXCEPTION 'invalid wallet';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than zero';
  END IF;

  IF p_user_type = 'customer' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_user_type, 0));
  END IF;

  SELECT wt.balance_after INTO v_prev
    FROM wallet_transactions wt
   WHERE wt.user_id = p_user_id AND wt.user_type = p_user_type
   ORDER BY wt.created_at DESC, wt.id DESC
   LIMIT 1;

  v_prev := COALESCE(v_prev, 0);
  IF v_prev < p_amount THEN
    RAISE EXCEPTION 'insufficient balance: %', v_prev;
  END IF;

  INSERT INTO wallet_transactions (
    user_id, user_type, transaction_type, amount, balance_after,
    description, reference_id, status
  ) VALUES (
    p_user_id, p_user_type, 'admin_debit', -p_amount,
    ROUND(v_prev - p_amount, 2), p_description, p_reference_id, 'completed'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION debit_wallet(UUID, TEXT, NUMERIC, TEXT, UUID) FROM PUBLIC, anon, authenticated;
