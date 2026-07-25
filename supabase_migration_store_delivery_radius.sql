-- Merchant-configurable maximum delivery radius.
-- Run this in Supabase Dashboard → SQL Editor BEFORE deploying the backend
-- that references delivery_radius_km.
--
-- Some merchants sell products that don't travel well over long distances
-- (hot food, ice cream, etc.) and asked to cap how far their store will
-- deliver. Settable during onboarding and editable later in Settings.
-- Default 10 km matches the distance merchants were previously told to
-- expect informally (this was never enforced before this column existed).

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS delivery_radius_km numeric(5,1) DEFAULT 10
    CHECK (delivery_radius_km > 0 AND delivery_radius_km <= 100);

COMMENT ON COLUMN stores.delivery_radius_km IS
  'Maximum distance (km) from the store the merchant is willing to deliver. Set during onboarding or Settings. Not yet enforced against customer checkout/browse distance — storage only for now.';
