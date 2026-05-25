-- Payout provider detection + merchant payout methods
-- Run via: psql or Supabase SQL editor.
--
-- Adds:
--   * courier_payout_methods.provider_code     — Contipay provider code (EC/NM/TC/IB/OM)
--   * courier_payout_methods.detection_method  — how the provider was chosen (prefix/manual/test_push)
--   * courier_payout_methods.verified_at       — timestamp when is_verified was set true
--   * merchant_payout_methods table (mirrors courier_payout_methods)

-- ── couriers ──────────────────────────────────────────────────────────────────
ALTER TABLE courier_payout_methods
  ADD COLUMN IF NOT EXISTS provider_code    TEXT,
  ADD COLUMN IF NOT EXISTS detection_method TEXT
    CHECK (detection_method IS NULL OR detection_method IN ('prefix', 'manual', 'test_push', 'name_lookup')),
  ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMP WITH TIME ZONE;

-- ── merchants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchant_payout_methods (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id      UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  method_type      TEXT NOT NULL CHECK (method_type IN ('mobile_money', 'bank_account')),
  provider         TEXT NOT NULL,
  provider_code    TEXT,
  account_number   TEXT NOT NULL,
  account_name     TEXT,
  detection_method TEXT CHECK (detection_method IS NULL OR detection_method IN ('prefix', 'manual', 'test_push', 'name_lookup')),
  is_default       BOOLEAN DEFAULT FALSE,
  is_verified      BOOLEAN DEFAULT FALSE,
  verified_at      TIMESTAMP WITH TIME ZONE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_payout_methods_merchant_id
  ON merchant_payout_methods(merchant_id);

ALTER TABLE merchant_payout_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Merchants can manage own payout methods" ON merchant_payout_methods;
CREATE POLICY "Merchants can manage own payout methods" ON merchant_payout_methods
  FOR ALL USING (auth.uid() = merchant_id);

COMMENT ON COLUMN courier_payout_methods.provider_code    IS 'Contipay provider code (EC/NM/TC/IB/OM)';
COMMENT ON COLUMN courier_payout_methods.detection_method IS 'How provider was chosen: prefix (auto), manual (user picked), test_push (verified via micro payment), name_lookup (Contipay name inquiry)';
COMMENT ON TABLE  merchant_payout_methods                 IS 'Where to send merchant earnings via Contipay /disburse/payment';
