-- Per-store delivery radius, in kilometres.
-- Run this in Supabase Dashboard → SQL Editor. The deployed backend already
-- references stores.delivery_radius_km, so until this runs these routes 500
-- with "column stores.delivery_radius_km does not exist":
--
--   GET   /stores                  (public store list + courier live map)
--   GET   /merchant/stores         (merchant store settings)
--   PATCH /merchant/stores/:id     (merchant saving store settings)
--   POST  /merchants/onboarding    (merchant signup)
--
-- NULL = no radius set for this store; the backend falls back to
--        DEFAULT_DELIVERY_RADIUS_KM (10 km, server.js). Left nullable rather
--        than defaulted to 10 so "never configured" stays distinguishable
--        from "deliberately set to 10".
--
-- PATCH /merchant/stores/:id rejects values that are not finite or are <= 0,
-- so the CHECK below mirrors that validation at the database level.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS delivery_radius_km numeric DEFAULT NULL;

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_delivery_radius_km_positive;

ALTER TABLE stores
  ADD CONSTRAINT stores_delivery_radius_km_positive
  CHECK (delivery_radius_km IS NULL OR delivery_radius_km > 0);

COMMENT ON COLUMN stores.delivery_radius_km IS
  'Delivery radius in km. NULL = unset; backend falls back to 10 km.';
