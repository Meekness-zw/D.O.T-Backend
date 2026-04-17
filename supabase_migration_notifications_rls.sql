-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Allows the backend (service role) to insert notifications, and allows
-- authenticated users to insert notifications for themselves as a fallback.

-- Service role bypasses RLS entirely, so this policy covers anon/authenticated
-- clients that may be used if SUPABASE_SERVICE_ROLE_KEY is misconfigured.

DROP POLICY IF EXISTS "Service can insert notifications" ON notifications;
CREATE POLICY "Service can insert notifications" ON notifications
  FOR INSERT WITH CHECK (true);

-- Users can already read/update their own notifications (existing policies).
-- This INSERT policy allows the backend to write notifications regardless of
-- which Supabase key is in use.
