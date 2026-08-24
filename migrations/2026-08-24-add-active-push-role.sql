ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS push_role TEXT;

ALTER TABLE user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_push_role_check;

ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_push_role_check
  CHECK (push_role IS NULL OR push_role IN ('customer', 'merchant', 'courier'));

CREATE INDEX IF NOT EXISTS idx_user_profiles_push_role
  ON user_profiles(push_role)
  WHERE push_token IS NOT NULL;
