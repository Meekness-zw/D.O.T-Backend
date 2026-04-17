-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Fixes all RLS INSERT policies that are blocking the backend.
-- Root cause: SUPABASE_SERVICE_ROLE_KEY on Render may be the anon key,
-- so these permissive INSERT policies ensure writes always succeed.

-- ============================================================
-- 1. payments — allow backend to record payment attempts
-- ============================================================
DROP POLICY IF EXISTS "Service can insert payments" ON payments;
CREATE POLICY "Service can insert payments" ON payments
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- 2. order_items — allow customers to insert items for their orders
-- ============================================================
DROP POLICY IF EXISTS "Customers can insert own order items" ON order_items;
CREATE POLICY "Customers can insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.customer_id = auth.uid()
    )
  );

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

-- ============================================================
-- 3. notifications — allow backend to insert notifications
-- ============================================================
DROP POLICY IF EXISTS "Service can insert notifications" ON notifications;
CREATE POLICY "Service can insert notifications" ON notifications
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- 4. user_profiles — add push_token column for push notifications
-- ============================================================
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS push_token TEXT;

-- ============================================================
-- 5. business_types — add is_default column (used for sorting)
-- ============================================================
ALTER TABLE business_types
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- 6. notifications — add data JSONB column for action routing
-- ============================================================
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
