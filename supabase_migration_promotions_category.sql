-- Add category column to promotions so a promotion can be linked to a store category by name.
-- Run in Supabase SQL Editor on existing projects.

ALTER TABLE promotions ADD COLUMN IF NOT EXISTS category TEXT;

COMMENT ON COLUMN promotions.category IS 'Optional category name this promotion applies to (e.g. Burgers, Drinks).';

