-- ============================================
-- MERCHANT PRODUCT-LIST SHARING (multi-branch chains)
-- ============================================
-- Lets one merchant (e.g. a restaurant branch) send a request to another
-- merchant to share their product/category list. Once accepted, the
-- recipient can pull ("import") the sender's products into their own store
-- at any time — items already present (matched by name) are skipped, so
-- repeated imports only bring in what's new. This is a one-time copy, not a
-- live sync: imported products become fully independent rows the recipient
-- can edit or delete freely.
--
-- Run this in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS merchant_share_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE, -- sender (offers to share)
  from_store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,      -- which store's product list is offered
  to_merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,  -- recipient (may import from it)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  responded_at TIMESTAMP WITH TIME ZONE,
  CHECK (from_merchant_id <> to_merchant_id)
);

-- One active (pending/accepted) link per sender-store -> recipient pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_share_links_unique_active
  ON merchant_share_links (from_store_id, to_merchant_id)
  WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS idx_merchant_share_links_to_merchant ON merchant_share_links(to_merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_merchant_share_links_from_merchant ON merchant_share_links(from_merchant_id, status);

-- All writes go through the backend service role (bypasses RLS); no public read needed.
ALTER TABLE merchant_share_links ENABLE ROW LEVEL SECURITY;
