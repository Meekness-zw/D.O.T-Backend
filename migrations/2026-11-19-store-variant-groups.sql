-- Saved variants: a store types a variant group once (e.g. Size: Small /
-- Medium +$1 / Large +$2) and ticks it on any product. Products keep their
-- own copy in product_option_groups (what the app and orders read), linked
-- back by variant_group_id so editing the saved group updates every product.
-- Deleting a saved group removes it from the products that used it.

CREATE TABLE IF NOT EXISTS store_variant_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT false,
  max_select INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_variant_groups_store ON store_variant_groups(store_id, display_order);

ALTER TABLE product_option_groups
  ADD COLUMN IF NOT EXISTS variant_group_id UUID REFERENCES store_variant_groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_product_option_groups_variant_group ON product_option_groups(variant_group_id);

-- Only the server (service role) reads and writes this table.
ALTER TABLE store_variant_groups ENABLE ROW LEVEL SECURITY;
