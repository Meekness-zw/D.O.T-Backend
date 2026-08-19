-- ============================================
-- QUICKBOOKS ONLINE INTEGRATION
-- ============================================
-- Lets the accounting/sales dashboard accounts connect the business's single
-- QuickBooks Online company via OAuth2, map our concepts (order revenue,
-- delivery fee, merchant/courier payouts) to QuickBooks accounts/items, and
-- sync paid orders as Sales Receipts + paid withdrawal requests as Expenses.
--
-- There is exactly one QuickBooks connection for the whole business (not one
-- per dashboard account) — the accountant and sales_marketing dashboard
-- accounts both operate against this same connection. Run this in the
-- Supabase SQL editor.

-- Singleton row: the business's QuickBooks OAuth connection.
-- Tokens are stored encrypted (AES-256-GCM) — see quickbooksService.js.
CREATE TABLE IF NOT EXISTS quickbooks_connections (
  id UUID PRIMARY KEY DEFAULT '11111111-1111-1111-1111-111111111111',
  realm_id TEXT NOT NULL,                 -- QuickBooks company id
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  company_name TEXT,
  access_token TEXT NOT NULL,             -- encrypted
  refresh_token TEXT NOT NULL,            -- encrypted
  access_token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  refresh_token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  connected_by TEXT,                      -- dashboard role that authorized ('admin' | 'accountant' | 'sales_marketing')
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT quickbooks_connections_singleton CHECK (id = '11111111-1111-1111-1111-111111111111')
);

-- How our concepts map onto this QuickBooks company's chart of accounts / items.
-- mapping_key values: 'sales_item', 'delivery_item', 'tax_item', 'default_customer',
--   'merchant_payout_account', 'courier_payout_account', 'payout_bank_account'
CREATE TABLE IF NOT EXISTS quickbooks_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mapping_key TEXT NOT NULL UNIQUE,
  qb_id TEXT NOT NULL,
  qb_name TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotency + audit trail: one row per (entity_type, entity_id) so an order
-- or withdrawal is never pushed to QuickBooks twice, even across retries.
CREATE TABLE IF NOT EXISTS quickbooks_sync_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'withdrawal')),
  entity_id UUID NOT NULL,
  qb_object_type TEXT,                    -- 'SalesReceipt' | 'Purchase'
  qb_object_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('synced', 'failed')),
  error_message TEXT,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_sync_log_status ON quickbooks_sync_log(status, synced_at DESC);

ALTER TABLE quickbooks_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE quickbooks_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quickbooks_sync_log ENABLE ROW LEVEL SECURITY;
-- All access goes through the backend service role (bypasses RLS) — no public policies.
