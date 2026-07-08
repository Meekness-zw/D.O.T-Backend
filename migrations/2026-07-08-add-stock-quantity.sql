-- Optional inventory tracking for products.
-- Run this in Supabase Dashboard → SQL Editor BEFORE deploying the backend
-- that references stock_quantity.
--
-- NULL  = inventory not tracked for this product (default; nothing changes)
-- 0..n  = items in stock; the backend decrements on each order, auto-sets
--         is_available = false at 0, and notifies the merchant at ≤5 and at 0.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_quantity integer DEFAULT NULL;

COMMENT ON COLUMN products.stock_quantity IS
  'Optional inventory count. NULL = untracked. Auto-decremented per order; product auto-disables at 0.';
