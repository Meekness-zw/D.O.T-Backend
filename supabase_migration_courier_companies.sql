-- ══════════════════════════════════════════════════════════════════════════
-- Umbrella courier companies.
--
-- A courier can now belong to a company. When they do, their delivery
-- earnings are paid to the COMPANY's account, not their own — the company
-- settles with its own riders off-platform. An unaffiliated courier is
-- unaffected and keeps being paid directly.
--
-- Jobs and movement stay attached to the individual courier: the company is a
-- payment destination and a reporting grouping, not a new actor. Re-pointing
-- delivery records at the company would destroy the per-rider history the
-- admin asked to be able to track.
--
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS courier_companies (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  registration_number TEXT,
  contact_name        TEXT,
  contact_phone       TEXT,
  contact_email       TEXT,
  address             TEXT,
  city                TEXT,

  -- Where the company's money goes. Same shape as courier_payout_methods so
  -- the disbursement path treats both the same and needs no second branch.
  payout_method_type  TEXT CHECK (payout_method_type IN ('mobile_money', 'bank_account')),
  payout_provider     TEXT,
  payout_provider_code TEXT,
  payout_account_number TEXT,
  payout_account_name TEXT,

  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  notes               TEXT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Two companies with the same name is a data-entry mistake, not a real case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_courier_companies_name
  ON courier_companies (lower(name));

-- ON DELETE SET NULL, deliberately: removing a company must not remove its
-- couriers or their delivery history. They simply revert to being paid
-- individually, which is a recoverable state — cascading here would delete
-- real people's accounts as a side effect of tidying up an org chart.
ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES courier_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_couriers_company ON couriers (company_id)
  WHERE company_id IS NOT NULL;

COMMENT ON COLUMN couriers.company_id IS
  'Umbrella company this courier rides for. When set, delivery payouts are disbursed to the company account instead of the courier''s own.';

-- Disbursements can now be addressed to a company. recipient_user_id is a
-- couriers/merchants id, which a company has no row in, so the column is
-- widened rather than reused: pointing it at a courier_companies id would
-- break the existing per-order uniqueness guarantee and every join that
-- assumes it names a user.
ALTER TABLE payout_disbursements
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES courier_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payout_disbursements_company
  ON payout_disbursements (company_id) WHERE company_id IS NOT NULL;

COMMENT ON COLUMN payout_disbursements.company_id IS
  'Set when this payout was routed to an umbrella company. recipient_user_id still names the courier who earned it, so per-courier history survives.';

ALTER TABLE courier_companies ENABLE ROW LEVEL SECURITY;

-- No public policy. The dashboard reaches this through the service-role key
-- only; couriers have no reason to enumerate companies, and the contact and
-- banking details here are not theirs to read.
