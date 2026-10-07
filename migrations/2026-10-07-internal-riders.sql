-- Internal DOT riders are employed by DOT. Job payouts stay off: the
-- delivery fee is not credited to their wallet and is not disbursed per order.
-- Existing couriers keep the default (paid per job).

ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN couriers.payouts_enabled IS
  'FALSE for internal DOT riders, who are paid by DOT rather than per job.';
