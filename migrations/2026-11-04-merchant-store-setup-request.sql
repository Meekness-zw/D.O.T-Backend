-- A merchant can skip store setup and ask the DOT team to set the store up
-- for them. They wait on the review page until the team has created the store
-- (admin dashboard: Merchants -> Set up store) and approved them.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS store_setup_requested_at timestamptz;
-- Optional details from the merchant for the team (store name, area, when to call).
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS store_setup_note text;
