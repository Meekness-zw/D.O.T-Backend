-- Sync user_profiles.email to the canonical email from auth.users.
-- This clears merchant business emails that were incorrectly written to user_profiles.email
-- during merchant onboarding. Phone-only users will have email set to NULL (correct).
-- Email-registered users will have their real auth email preserved.

UPDATE user_profiles up
SET email = au.email
FROM auth.users au
WHERE au.id = up.id
  AND up.email IS DISTINCT FROM au.email;
