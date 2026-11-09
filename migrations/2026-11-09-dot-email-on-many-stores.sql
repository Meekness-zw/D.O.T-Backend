-- Stores the DOT team creates use admin@deliveryontime.co.zw as their email,
-- so sign-in codes for all of them reach the DOT inbox. Every other email
-- stays unique to one account, as before.
-- Run in the Supabase SQL editor.

ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_email_unique_except_dot
  ON user_profiles (email)
  WHERE email IS NOT NULL AND lower(email) <> 'admin@deliveryontime.co.zw';
