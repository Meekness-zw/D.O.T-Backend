-- ══════════════════════════════════════════════════════════════════════════
-- Courier tips.
--
-- The courier marketing site has always promised "100% of your tips", but
-- there was nowhere to record one: no column, no API field, no screen. This
-- adds the column and the ledger type behind that promise.
--
-- 100% means 100%. The tip is NOT part of the delivery fee, so it never goes
-- through computeCourierDeliveryPayoutUsd and DOT's 20% delivery cut never
-- touches it. Keeping it in its own column rather than folding it into
-- delivery_fee is what makes that guarantee checkable after the fact.
--
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS courier_tip NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_courier_tip_non_negative'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_courier_tip_non_negative CHECK (courier_tip >= 0);
  END IF;
END $$;

COMMENT ON COLUMN orders.courier_tip IS
  'Optional customer tip, paid to the courier in full. Included in total_amount; excluded from delivery_fee so the platform cut cannot reach it.';

-- The tip is credited as its own ledger line, not merged into the delivery
-- earnings row. A courier querying "what did I earn in tips this week" must be
-- able to answer it, and an accountant needs to see the two amounts separately
-- when they disburse.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_transaction_type_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'deposit', 'withdrawal', 'payment', 'refund', 'payout', 'earnings',
    'promo_credit',   -- admin promotional top-up
    'tip'             -- customer tip, courier keeps all of it
  ));
-- NB: supabase_migration_wallet_promo_credit.sql DROPs and re-ADDs this same
-- constraint. Its list is kept identical to this one so the two can be run in
-- either order; if you add a type, add it in both files.

-- Reporting path for the accountant console: "orders delivered in this window
-- that carried a tip".
CREATE INDEX IF NOT EXISTS idx_orders_courier_tip
  ON orders (courier_id, created_at DESC)
  WHERE courier_tip > 0;
