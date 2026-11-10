-- DOT team: computers that have signed in with the emailed code are
-- remembered, so they skip the code next time and sign back in by themselves
-- when the session lapses. Only a hash of each device key is stored.
-- A device is forgotten after 90 days without use, on "forget this PC",
-- or when the account's password, email, role or status changes.
CREATE TABLE IF NOT EXISTS admin_trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS admin_trusted_devices_user_idx ON admin_trusted_devices (admin_user_id);

-- Only the backend (service role) reads or writes this table.
ALTER TABLE admin_trusted_devices ENABLE ROW LEVEL SECURITY;
