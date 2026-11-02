-- Sign in with a 4-digit PIN (or Face ID / fingerprint) instead of a password.
--
-- user_profiles.pin_hash: bcrypt hash of the account PIN. Once set, password
-- sign-in is refused for that account.
-- pin_failed_attempts / pin_locked_until: wrong PINs are counted; after 5 the
-- PIN is locked until it is reset with an emailed code.
--
-- trusted_devices: phones and browsers that have proven themselves with an
-- emailed code. Only a trusted device can sign in with phone + PIN, so a PIN
-- alone is useless on someone else's phone. 'biometric' tokens sign in on
-- their own, behind the phone's Face ID / fingerprint check.
-- Only token hashes are stored.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pin_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;

CREATE TABLE IF NOT EXISTS trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('device', 'biometric')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trusted_devices_user_id_idx ON trusted_devices (user_id);

-- Only the backend (service role) reads or writes this table.
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
