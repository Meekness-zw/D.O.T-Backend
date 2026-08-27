-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Per-admin accounts with TOTP two-factor for the admin dashboard.
--
-- Replaces the three shared role API keys (ADMIN_API_KEY / ACCOUNTANT_API_KEY /
-- SALES_MARKETING_API_KEY), where the key WAS the whole credential: anyone
-- holding it had that role's access, forever, with no record of who acted.
-- Each person now gets their own account, their own authenticator seed, and
-- every mutating request is attributed to them by name.
--
-- Rollout is deliberately non-breaking: while admin_users is EMPTY the server
-- keeps accepting the old env keys exactly as before, so deploying this does
-- not lock anyone out. The moment the first account exists, the env keys stop
-- granting dashboard access and are only honoured by /admin/auth/bootstrap.

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  full_name TEXT,
  -- bcrypt, same cost factor as the customer password path.
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'accountant', 'sales_marketing')),
  -- Base32 authenticator seed. NULL until the person completes enrollment,
  -- which they are forced through on first sign-in.
  totp_secret TEXT,
  totp_enrolled_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  -- Throttling state for both the password and the TOTP step. A 6-digit code
  -- is only a million guesses, so an unthrottled verify endpoint is not 2FA.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMP WITH TIME ZONE,
  last_login_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL
);

-- Usernames are matched case-insensitively, so uniqueness must be too —
-- otherwise "Tafara" and "tafara" become two accounts that both log in as one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username_lower
  ON admin_users (LOWER(username));

-- Single-use backup codes, for the day someone's phone is lost or wiped.
-- Without these, a lost device means editing the database by hand.
CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- SHA-256, not bcrypt: these are 50 bits of server-generated randomness,
  -- not a human-chosen password, so there is nothing to brute force and no
  -- reason to pay bcrypt's cost ten times per recovery attempt.
  code_hash TEXT NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_user
  ON admin_recovery_codes(admin_user_id) WHERE used_at IS NULL;

-- Sessions issued after BOTH factors pass. The dashboard sends one of these
-- instead of a long-lived key, so a token lifted from a browser expires on
-- its own and can be revoked centrally.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- Only the SHA-256 of the token is stored. A leaked database backup
  -- therefore does not hand over live sessions.
  token_hash TEXT NOT NULL UNIQUE,
  -- TRUE between the password step and the TOTP step. Such a session proves
  -- only the first factor and is refused by every dashboard endpoint.
  mfa_pending BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

-- The point of per-person accounts: an attributable record of who did what.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  -- Denormalised so the trail still names a person after the account is
  -- deleted; the FK above would otherwise null out exactly the rows that
  -- matter most in an investigation.
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  ip TEXT,
  detail JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_user ON admin_audit_log(admin_user_id, created_at DESC);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- These tables are reached only through the backend's service-role client.
-- No anon/authenticated policy is defined, so PostgREST exposes nothing:
-- password hashes and TOTP seeds must never be reachable from a browser.
DROP POLICY IF EXISTS "Service role full access on admin_users" ON admin_users;
CREATE POLICY "Service role full access on admin_users"
  ON admin_users FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on admin_recovery_codes" ON admin_recovery_codes;
CREATE POLICY "Service role full access on admin_recovery_codes"
  ON admin_recovery_codes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on admin_sessions" ON admin_sessions;
CREATE POLICY "Service role full access on admin_sessions"
  ON admin_sessions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on admin_audit_log" ON admin_audit_log;
CREATE POLICY "Service role full access on admin_audit_log"
  ON admin_audit_log FOR ALL USING (true) WITH CHECK (true);

COMMENT ON COLUMN admin_users.totp_secret IS
  'Base32 TOTP seed. Treat as a credential: never return it after enrollment completes.';
COMMENT ON COLUMN admin_sessions.mfa_pending IS
  'TRUE = password accepted but TOTP not yet verified. Never grants dashboard access.';
