-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Adds push_token column to user_profiles for storing Expo push notification tokens.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS push_token TEXT;
