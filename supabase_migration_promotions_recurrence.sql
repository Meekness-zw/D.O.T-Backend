-- Add recurrence columns so promotions can auto-post weekly or monthly.
-- Run in Supabase SQL Editor on existing projects.

ALTER TABLE promotions ADD COLUMN IF NOT EXISTS recurrence_type TEXT DEFAULT 'once' CHECK (recurrence_type IN ('once', 'weekly', 'monthly'));
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS recurrence_weekday SMALLINT CHECK (recurrence_weekday IS NULL OR (recurrence_weekday >= 0 AND recurrence_weekday <= 6));
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS recurrence_month_day SMALLINT CHECK (recurrence_month_day IS NULL OR (recurrence_month_day >= 1 AND recurrence_month_day <= 31));
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS recurrence_time TEXT;

COMMENT ON COLUMN promotions.recurrence_type IS 'once | weekly | monthly: when to auto-post';
COMMENT ON COLUMN promotions.recurrence_weekday IS '0=Sunday..6=Saturday for weekly';
COMMENT ON COLUMN promotions.recurrence_month_day IS '1-31 for monthly';
COMMENT ON COLUMN promotions.recurrence_time IS 'HH:MM 24h time to post';
