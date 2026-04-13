-- Add is_suspended column to user_profiles table
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE;
