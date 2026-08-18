-- Lets a specific account (e.g. the client's own) browse every active
-- store on GET /stores regardless of distance/delivery_radius_km, instead
-- of only stores within range of their current location.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS unrestricted_browsing BOOLEAN NOT NULL DEFAULT FALSE;

-- Run this separately once you know the account's phone number or email —
-- flips the flag on for that one account only. Everyone else is unaffected.
-- UPDATE user_profiles SET unrestricted_browsing = TRUE WHERE phone = '+263...';
-- UPDATE user_profiles SET unrestricted_browsing = TRUE WHERE email = 'client@example.com';
