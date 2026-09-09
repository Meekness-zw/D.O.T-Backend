-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Lets an admin credit a customer's DOT wallet as a promotion.
--
-- Two things are needed: a transaction type the constraint will accept, and a
-- way to write the row that cannot lose money when something else touches the
-- same wallet at the same moment.

-- ── 1. A distinct transaction type ─────────────────────────────────────────
--
-- Not 'deposit'. A deposit is the customer's own money and is a liability the
-- business owes back; a promo credit is marketing spend the business funded.
-- Recording both the same way would overstate customer deposits and hide what
-- promotions actually cost, and there would be no way to separate them later.

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_transaction_type_check;

ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'deposit', 'withdrawal', 'payment', 'refund', 'payout', 'earnings',
    'promo_credit'
  ));

COMMENT ON COLUMN wallet_transactions.transaction_type IS
  'promo_credit = admin-issued promotional balance. Funded by DOT, not paid in by the customer, so it is marketing spend rather than a deposit liability.';

-- ── 2. An atomic credit ────────────────────────────────────────────────────
--
-- This wallet keeps a running balance: each row stores balance_after, and the
-- current balance is whatever the newest row says. Reading that in the API and
-- then inserting is a lost-update waiting to happen — two writers both read
-- the same balance, and the second overwrites the first's effect. Money simply
-- disappears. That is not hypothetical here: an admin can credit an account at
-- the same moment the customer is checking out, and checkout writes to this
-- same table.
--
-- The advisory lock is taken on the customer id and released when the
-- transaction ends, so concurrent credits to one wallet queue up instead of
-- racing. Credits to different wallets are unaffected.

CREATE OR REPLACE FUNCTION credit_customer_wallet(
  p_user_id UUID,
  p_amount NUMERIC,
  p_description TEXT,
  p_reference_id UUID DEFAULT NULL,
  p_transaction_type TEXT DEFAULT 'promo_credit'
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
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than zero';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- created_at alone is not a reliable ordering: two rows written in the same
  -- millisecond tie, and "the newest" becomes whichever the planner returns.
  -- id breaks the tie deterministically.
  SELECT balance_after INTO v_prev
    FROM wallet_transactions
   WHERE user_id = p_user_id AND user_type = 'customer'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  v_prev := COALESCE(v_prev, 0);

  INSERT INTO wallet_transactions (
    user_id, user_type, transaction_type, amount, balance_after,
    description, reference_id, status
  ) VALUES (
    p_user_id, 'customer', p_transaction_type, p_amount,
    ROUND(v_prev + p_amount, 2), p_description, p_reference_id, 'completed'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Reachable only through the backend's service-role client.
REVOKE ALL ON FUNCTION credit_customer_wallet(UUID, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION credit_customer_wallet IS
  'Atomically appends a credit to a customer wallet. Takes an advisory lock on the customer so a concurrent write cannot clobber the running balance.';
