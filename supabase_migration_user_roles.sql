-- Multi-role support: one user can have multiple roles (e.g. merchant + customer).
-- user_profiles.role remains as "primary" role for backward compatibility.
-- user_roles is the source of truth for "which roles does this user have".

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'merchant', 'courier')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

-- Backfill: every existing profile gets one row in user_roles for their current role
INSERT INTO user_roles (user_id, role)
  SELECT id, role FROM user_profiles
  ON CONFLICT (user_id, role) DO NOTHING;

COMMENT ON TABLE user_roles IS 'All roles a user has; one user can be both merchant and customer.';
