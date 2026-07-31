-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- In-app texting between a courier and the customer for a specific order
-- (client-requested: "an in-app texting feature where the courier can text
-- the customer"). Two-way — the customer can reply too. Scoped to one order
-- so the thread naturally disappears from relevance once delivery is done.

CREATE TABLE IF NOT EXISTS order_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'courier')),
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_messages_order_id ON order_messages(order_id, created_at);

-- Backend uses the service role for all reads/writes (authorization — is this
-- user the order's customer or courier? — is enforced in the API layer, same
-- pattern as order_status_history). RLS is enabled with a permissive
-- service-role policy as belt-and-suspenders, matching the rest of the schema.
ALTER TABLE order_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on order_messages" ON order_messages;
CREATE POLICY "Service role full access on order_messages"
  ON order_messages
  FOR ALL
  USING (true)
  WITH CHECK (true);
