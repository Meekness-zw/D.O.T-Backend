-- Add category column to products so category is stored on the product row.
-- Run in Supabase SQL Editor on existing projects.

-- Add column
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;

-- Backfill from product_categories for existing products
UPDATE products
SET category = (
  SELECT name FROM product_categories
  WHERE product_categories.id = products.category_id
)
WHERE category_id IS NOT NULL AND (category IS NULL OR category = '');

-- Optional: index for filtering by category per store
CREATE INDEX IF NOT EXISTS idx_products_category ON products(store_id, category);

COMMENT ON COLUMN products.category IS 'Category name stored on product (e.g. Burgers, Drinks)';
