-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Adds an AI-verified category override to stores. Merchants sometimes pick
-- the wrong business type at onboarding (e.g. a butcher selecting "Grocery");
-- when set, category_override is the AI-corrected category name and takes
-- priority over merchants.business_type for customer-facing category display.
-- NULL means "not yet verified" — the backend resolves it lazily and caches
-- the result here permanently (same pattern as business_types.icon).

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS category_override TEXT;
