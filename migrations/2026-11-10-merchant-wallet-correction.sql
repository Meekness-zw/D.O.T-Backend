-- One-time correction of merchant wallet balances, now that merchants are paid
-- through their wallet + withdrawals (like couriers) and the app shows the
-- full balance instead of only the last 24 hours.
--
-- Two kinds of money are still sitting in merchant wallets that shouldn't be:
--   1. Store shares the accountant already paid out from Settlements.
--   2. Store shares of orders that were cancelled and refunded to the
--      customer (late cancellations excluded: DOT pays the store for those).
--
-- Run STEP 1 first and check the numbers. Then run STEP 2 once. STEP 2 skips
-- merchants it has already corrected, so running it twice does nothing more.

-- ── STEP 1: preview (changes nothing) ──────────────────────────────────────
WITH settled AS (
  SELECT recipient_user_id AS merchant_id, SUM(amount) AS amount
  FROM payout_disbursements
  WHERE recipient_type = 'merchant' AND status = 'completed'
  GROUP BY recipient_user_id
),
refunded AS (
  SELECT wt.user_id AS merchant_id, SUM(wt.amount) AS amount
  FROM wallet_transactions wt
  JOIN payments p ON p.id = wt.reference_id
  JOIN orders o ON o.id = p.order_id
  WHERE wt.user_type = 'merchant'
    AND wt.transaction_type = 'earnings'
    AND o.status = 'cancelled'
    AND o.payment_status = 'refunded'
    AND NOT EXISTS (
      SELECT 1 FROM order_status_history h
      WHERE h.order_id = o.id
        AND h.notes = 'Cancelled by customer: not delivered within 60 minutes of handover'
    )
    AND NOT EXISTS (
      SELECT 1 FROM wallet_transactions r
      WHERE r.user_id = wt.user_id AND r.user_type = 'merchant'
        AND r.transaction_type = 'refund' AND r.reference_id = o.id
    )
  GROUP BY wt.user_id
),
balances AS (
  SELECT DISTINCT ON (user_id) user_id AS merchant_id, balance_after AS balance
  FROM wallet_transactions
  WHERE user_type = 'merchant'
  ORDER BY user_id, created_at DESC
)
SELECT
  m.business_name,
  COALESCE(b.balance, 0)                                   AS wallet_now,
  COALESCE(s.amount, 0)                                    AS already_paid_via_settlements,
  COALESCE(r.amount, 0)                                    AS refunded_orders,
  COALESCE(b.balance, 0) - COALESCE(s.amount, 0) - COALESCE(r.amount, 0) AS wallet_after
FROM merchants m
LEFT JOIN balances b ON b.merchant_id = m.id
LEFT JOIN settled s ON s.merchant_id = m.id
LEFT JOIN refunded r ON r.merchant_id = m.id
WHERE COALESCE(b.balance, 0) <> 0 OR s.amount IS NOT NULL OR r.amount IS NOT NULL
ORDER BY m.business_name;


-- ── STEP 2: apply (one correction entry per merchant) ──────────────────────
/*
WITH settled AS (
  SELECT recipient_user_id AS merchant_id, SUM(amount) AS amount
  FROM payout_disbursements
  WHERE recipient_type = 'merchant' AND status = 'completed'
  GROUP BY recipient_user_id
),
refunded AS (
  SELECT wt.user_id AS merchant_id, SUM(wt.amount) AS amount
  FROM wallet_transactions wt
  JOIN payments p ON p.id = wt.reference_id
  JOIN orders o ON o.id = p.order_id
  WHERE wt.user_type = 'merchant'
    AND wt.transaction_type = 'earnings'
    AND o.status = 'cancelled'
    AND o.payment_status = 'refunded'
    AND NOT EXISTS (
      SELECT 1 FROM order_status_history h
      WHERE h.order_id = o.id
        AND h.notes = 'Cancelled by customer: not delivered within 60 minutes of handover'
    )
    AND NOT EXISTS (
      SELECT 1 FROM wallet_transactions r
      WHERE r.user_id = wt.user_id AND r.user_type = 'merchant'
        AND r.transaction_type = 'refund' AND r.reference_id = o.id
    )
  GROUP BY wt.user_id
),
balances AS (
  SELECT DISTINCT ON (user_id) user_id AS merchant_id, balance_after AS balance
  FROM wallet_transactions
  WHERE user_type = 'merchant'
  ORDER BY user_id, created_at DESC
),
corrections AS (
  SELECT
    b.merchant_id,
    b.balance,
    COALESCE(s.amount, 0) + COALESCE(r.amount, 0) AS amount
  FROM balances b
  LEFT JOIN settled s ON s.merchant_id = b.merchant_id
  LEFT JOIN refunded r ON r.merchant_id = b.merchant_id
  WHERE COALESCE(s.amount, 0) + COALESCE(r.amount, 0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM wallet_transactions done
      WHERE done.user_id = b.merchant_id AND done.user_type = 'merchant'
        AND done.description LIKE 'Balance correction:%'
    )
)
INSERT INTO wallet_transactions
  (user_id, user_type, transaction_type, amount, balance_after, description, status)
SELECT
  merchant_id,
  'merchant',
  'payout',
  -ROUND(amount::numeric, 2),
  ROUND((balance - amount)::numeric, 2),
  'Balance correction: already paid via Settlements, or refunded orders',
  'completed'
FROM corrections;
*/
