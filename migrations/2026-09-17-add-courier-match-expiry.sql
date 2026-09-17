-- Lets an unaccepted order be pulled from every courier's open-jobs list
-- after 45 minutes of nobody claiming it, and tracks when that clock
-- started so it can be restarted (by a merchant repost, or a courier drop
-- putting the order back in the open pool).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS courier_match_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS courier_match_expired_at TIMESTAMP WITH TIME ZONE;

-- Backfill: any order already sitting open and unaccepted starts its clock
-- now rather than being treated as instantly overdue.
UPDATE public.orders
SET courier_match_started_at = NOW()
WHERE status IN ('preparing', 'ready')
  AND courier_id IS NULL
  AND courier_match_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_courier_match_started_at
  ON public.orders(courier_match_started_at)
  WHERE courier_id IS NULL AND courier_match_expired_at IS NULL;
