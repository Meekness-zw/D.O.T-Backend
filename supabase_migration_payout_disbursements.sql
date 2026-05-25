-- Outbound payouts via Contipay /disburse/payment.
-- One row per disbursement attempt. Status transitions: pending → completed/failed.
-- Idempotency: (order_id, recipient_user_id, recipient_type) unique while status='completed'.

CREATE TABLE IF NOT EXISTS payout_disbursements (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,
  recipient_user_id   UUID NOT NULL,
  recipient_type      TEXT NOT NULL CHECK (recipient_type IN ('courier', 'merchant')),
  payout_method_id    UUID,
  amount              NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  provider            TEXT,
  provider_code       TEXT,
  account_number      TEXT NOT NULL,
  account_name        TEXT,
  reference           TEXT NOT NULL UNIQUE,
  contipay_ref        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'failed')),
  status_code         INTEGER,
  error_message       TEXT,
  raw_request         JSONB,
  raw_response        JSONB,
  webhook_payload     JSONB,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at        TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_payout_disbursements_recipient
  ON payout_disbursements(recipient_user_id, recipient_type);
CREATE INDEX IF NOT EXISTS idx_payout_disbursements_order
  ON payout_disbursements(order_id);
CREATE INDEX IF NOT EXISTS idx_payout_disbursements_status
  ON payout_disbursements(status);

-- Prevent double-paying the same recipient for the same order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_disbursements_completed_per_order
  ON payout_disbursements(order_id, recipient_user_id, recipient_type)
  WHERE status = 'completed';

ALTER TABLE payout_disbursements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own payouts" ON payout_disbursements;
CREATE POLICY "Users can view own payouts" ON payout_disbursements
  FOR SELECT USING (auth.uid() = recipient_user_id);

COMMENT ON TABLE  payout_disbursements IS 'Outbound transfers to courier/merchant mobile wallets via Contipay /disburse/payment';
COMMENT ON COLUMN payout_disbursements.reference  IS 'Our merchant reference (DOT-PO-<orderShort>-<recipient>)';
COMMENT ON COLUMN payout_disbursements.contipay_ref IS 'ContiPay transaction reference returned in their response/webhook';
