-- Live courier position on the order row (updated by courier app; customer map reads via GET /orders/:id)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_latitude DECIMAL(10, 8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_longitude DECIMAL(11, 8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_location_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.courier_latitude IS 'Last reported GPS latitude while courier is on this order';
COMMENT ON COLUMN orders.courier_longitude IS 'Last reported GPS longitude while courier is on this order';
