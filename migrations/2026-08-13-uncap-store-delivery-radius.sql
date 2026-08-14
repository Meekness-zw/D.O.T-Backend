-- Merchants may choose any positive delivery/market radius.
-- This is safe to run even if an earlier uncapping migration was applied.
ALTER TABLE stores
  ALTER COLUMN delivery_radius_km TYPE numeric;

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_delivery_radius_km_positive;

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_delivery_radius_km_check;

ALTER TABLE stores
  ADD CONSTRAINT stores_delivery_radius_km_positive
  CHECK (delivery_radius_km IS NULL OR delivery_radius_km > 0);

COMMENT ON COLUMN stores.delivery_radius_km IS
  'Merchant-selected delivery/market radius in kilometres. Any positive distance is allowed.';
