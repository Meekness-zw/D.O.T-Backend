-- Run in Supabase SQL Editor, AFTER supabase_migration_admin_2fa.sql.
--
-- Moves the admin second factor from an authenticator app to a code emailed
-- to each admin's own address.
--
-- Accounts stay per-person: the code goes to that individual's mailbox, not to
-- a shared one, so the audit log can still name who acted. A single shared
-- inbox would have made every entry read the same and turned inbox access
-- into admin access.

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email TEXT;

-- Case-insensitive uniqueness: Tafara@ and tafara@ are the same mailbox, and
-- two accounts sharing one would both receive each other's codes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_lower
  ON admin_users (LOWER(email)) WHERE email IS NOT NULL;

-- One row per code issued. Kept separate from admin_users so a code can be
-- expired, counted and rate-limited without touching the account record.
CREATE TABLE IF NOT EXISTS admin_login_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- SHA-256 of the six digits. A leaked backup must not contain live codes.
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE,
  -- Wrong guesses against THIS code. Six digits is a million combinations, so
  -- a code that can be guessed at indefinitely is not a second factor.
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_codes_user
  ON admin_login_codes(admin_user_id, created_at DESC);

ALTER TABLE admin_login_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on admin_login_codes" ON admin_login_codes;
CREATE POLICY "Service role full access on admin_login_codes"
  ON admin_login_codes FOR ALL USING (true) WITH CHECK (true);

-- admin_users.totp_secret / totp_enrolled_at are left in place but no longer
-- read: dropping them would lose nothing useful but makes this migration
-- irreversible if you ever want the authenticator option back.
COMMENT ON COLUMN admin_users.totp_secret IS
  'Unused since the move to emailed codes. Retained so the authenticator flow can be restored.';
COMMENT ON COLUMN admin_users.email IS
  'Where this admin receives sign-in codes. Required for sign-in.';
