-- Stores are re-checked once when the category rules change, so food outlets
-- filed under "Restaurant / Food" before specialist categories existed (Sushi,
-- Pizza, Chicken…) get moved. NULL or an older number = not checked under the
-- current rules yet; the server checks them in small batches in the background.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS category_checked_version integer;
