-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- order_items has RLS enabled but no policies, which blocks all non-service-role
-- operations. These policies fix both the INSERT (order placement) and SELECT
-- (order history / embedded joins) issues.

-- 1. Allow customers to insert items for orders they own.
DROP POLICY IF EXISTS "Customers can insert own order items" ON order_items;
CREATE POLICY "Customers can insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.customer_id = auth.uid()
    )
  );

-- 2. Allow customers, the store's merchant, and the assigned courier to read items.
--    (orders links to merchants via store_id → stores.merchant_id, not a direct column)
DROP POLICY IF EXISTS "Users can view order items for their orders" ON order_items;
CREATE POLICY "Users can view order items for their orders" ON order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND (
          orders.customer_id = auth.uid()
          OR orders.courier_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM stores
            WHERE stores.id = orders.store_id
              AND stores.merchant_id = auth.uid()
          )
        )
    )
  );
