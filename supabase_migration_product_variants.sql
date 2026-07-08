-- ============================================
-- PRODUCT VARIANTS (option groups + options)
-- ============================================
-- Lets a merchant define choice groups on a product (e.g. "Flavor", "Size",
-- "Color") so one product covers all its variations instead of duplicates.
-- Each option can carry a price adjustment (+/- USD) applied on top of the
-- product's base price. The customer's picks are snapshotted onto the order
-- item at checkout time (order_items.selected_options).
--
-- Run this in the Supabase SQL editor.

-- Option groups: one row per choice section on a product
CREATE TABLE IF NOT EXISTS product_option_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- e.g. 'Flavor', 'Size', 'Color'
  is_required BOOLEAN DEFAULT FALSE,        -- customer must pick before adding to cart
  max_select INTEGER DEFAULT 1 CHECK (max_select >= 1), -- 1 = single choice, >1 = multi-select (e.g. toppings)
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Options: the selectable values inside a group
CREATE TABLE IF NOT EXISTS product_options (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- e.g. 'Strawberry', 'Large', 'Red'
  price_adjustment DECIMAL(10, 2) DEFAULT 0, -- added to base price when selected (can be negative)
  is_available BOOLEAN DEFAULT TRUE,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_option_groups_product_id ON product_option_groups(product_id);
CREATE INDEX IF NOT EXISTS idx_product_options_group_id ON product_options(group_id);

-- Snapshot of the customer's variant picks at order time:
-- [{ "group": "Flavor", "option": "Strawberry", "price_adjustment": 0.5 }, ...]
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS selected_options JSONB;

-- updated_at trigger (reuses the shared function from the base schema)
DROP TRIGGER IF EXISTS update_product_option_groups_updated_at ON product_option_groups;
CREATE TRIGGER update_product_option_groups_updated_at
  BEFORE UPDATE ON product_option_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: menus are public, so option groups/options are publicly readable.
-- All writes go through the backend service role (bypasses RLS).
ALTER TABLE product_option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read product option groups" ON product_option_groups;
CREATE POLICY "Public can read product option groups"
  ON product_option_groups FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Public can read product options" ON product_options;
CREATE POLICY "Public can read product options"
  ON product_options FOR SELECT
  USING (true);
