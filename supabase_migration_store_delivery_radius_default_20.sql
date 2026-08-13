-- Raises the default delivery radius for NEW stores (that don't set their
-- own radius during onboarding) from 10km to 20km, matching the app's
-- runtime fallback (DEFAULT_DELIVERY_RADIUS_KM in backend/src/server.js).
-- Existing NULL rows are unaffected by this — they already use the JS
-- fallback at query time — this only changes the column default applied
-- on future inserts that omit delivery_radius_km.
ALTER TABLE stores
  ALTER COLUMN delivery_radius_km SET DEFAULT 20;
