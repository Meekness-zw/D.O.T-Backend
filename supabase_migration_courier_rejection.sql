-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Rejecting a courier used to hard-delete their documents/vehicle/payout
-- data with no persisted reason, so a rejected courier reopening the app
-- just saw onboarding reset to "not started" with zero explanation. This
-- brings couriers in line with how merchant rejection already works
-- (approval_status/rejected_reason kept on the row, nothing deleted).

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
