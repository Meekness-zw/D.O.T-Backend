-- Merchants want to set their delivery/market radius to any distance they
-- choose, not capped at 100km. Remove the numeric precision too so the
-- database does not introduce a different hidden upper limit.
-- here. Still must be a positive number.
ALTER TABLE stores
  ALTER COLUMN delivery_radius_km TYPE numeric;

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_delivery_radius_km_check;

ALTER TABLE stores
  ADD CONSTRAINT stores_delivery_radius_km_check CHECK (delivery_radius_km > 0);
