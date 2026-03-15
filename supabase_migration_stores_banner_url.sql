-- Ensure stores has banner_url (for older projects that created stores before this column existed).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS banner_url TEXT;

COMMENT ON COLUMN stores.banner_url IS 'Optional banner image URL for the store (uploaded to store-logos bucket).';
