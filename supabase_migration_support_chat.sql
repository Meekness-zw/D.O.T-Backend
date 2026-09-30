-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- In-app support chat: a user talks to the DOT assistant, and the thread
-- can be handed to the admin, marketing, or accountant dashboards.

CREATE TABLE IF NOT EXISTS support_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  user_role TEXT NOT NULL CHECK (user_role IN ('customer', 'merchant', 'courier')),
  status TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'waiting_agent', 'with_agent', 'closed')),
  assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN ('admin', 'sales_marketing', 'accountant')),
  unread_for_staff INTEGER NOT NULL DEFAULT 0,
  unread_for_user INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_message_preview TEXT,
  escalated_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_user
  ON support_conversations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_conversations_inbox
  ON support_conversations(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'bot', 'agent')),
  sender_role TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
  ON support_messages(conversation_id, created_at);

ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on support_conversations" ON support_conversations;
CREATE POLICY "Service role full access on support_conversations"
  ON support_conversations
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on support_messages" ON support_messages;
CREATE POLICY "Service role full access on support_messages"
  ON support_messages
  FOR ALL
  USING (true)
  WITH CHECK (true);
