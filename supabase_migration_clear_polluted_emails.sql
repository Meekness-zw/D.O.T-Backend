-- Clear user_profiles.email for phone-only accounts where it was polluted by merchant onboarding.
-- A phone-only account is one where auth.users has no email but user_profiles.email is non-null.
-- Onboarding no longer writes to user_profiles.email, so this is a one-time cleanup.

UPDATE user_profiles up
SET email = NULL
WHERE up.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.users au
    WHERE au.id = up.id
      AND au.email IS NOT NULL
      AND au.email <> ''
  );
