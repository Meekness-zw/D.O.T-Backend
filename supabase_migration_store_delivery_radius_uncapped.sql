-- Merchants want to set their delivery/market radius to any distance they
-- choose, not capped at 100km. The original column (numeric(5,1)) can only
-- store up to 999.9, and had a CHECK limiting it to <= 100 — both removed
-- here. Still must be a positive number.
ALTER TABLE stores
  ALTER COLUMN delivery_radius_km TYPE numeric(7,1);

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_delivery_radius_km_check;

ALTER TABLE stores
  ADD CONSTRAINT stores_delivery_radius_km_check CHECK (delivery_radius_km > 0);
