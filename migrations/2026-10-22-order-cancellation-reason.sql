-- Run in the Supabase SQL editor, then: NOTIFY pgrst, 'reload schema';
--
-- Stores why a merchant cancelled an order. The reason is also written to
-- order_status_history, so cancelling works before this has run.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
