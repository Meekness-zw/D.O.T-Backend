-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Adds a data JSONB column to notifications for storing structured metadata
-- (e.g. orderId, orderNumber, paymentMethod, storeName, amount) so the
-- mobile app can navigate directly to the right screen from a notification.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
