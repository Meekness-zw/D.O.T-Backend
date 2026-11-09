-- Stores the DOT team runs for the merchant (see src/merchantControl.js).
-- Ticked per merchant in the admin dashboard; only these appear in the DOT
-- team's store switcher on the merchant dashboard.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS managed_by_dot boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS merchants_managed_by_dot_idx ON merchants (managed_by_dot) WHERE managed_by_dot;
