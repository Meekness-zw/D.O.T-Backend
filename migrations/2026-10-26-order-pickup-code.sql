-- Run in the Supabase SQL editor BEFORE deploying the backend that reads it,
-- then: NOTIFY pgrst, 'reload schema';
--
-- A 2-digit code made when a courier accepts an order. The courier and the
-- merchant both see it; the merchant releases the order only to a courier
-- showing the matching code. Cleared when the courier drops the job.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_code text;
