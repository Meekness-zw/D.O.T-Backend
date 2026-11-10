-- Where each courier was last seen, so the admin couriers map can show riders
-- who are online but not on a job (job positions live on the order).
-- The courier app reports it about once a minute while the courier is online.
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS last_latitude double precision;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS last_longitude double precision;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS last_location_at timestamptz;
