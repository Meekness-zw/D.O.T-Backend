-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Adds 'message' and 'announcement' to notifications.type's allowed values.
--
-- 'message' was already being used by the in-app chat feature (order_messages)
-- but was never added here — every "New message from customer/rider"
-- notification has been silently failing to insert (caught and logged, but
-- never surfaced) since the CHECK constraint only allowed the original 5
-- values. The push notification itself still went out; only the persisted
-- row (and therefore the Notification Center list + tap-to-reply) was
-- missing. This also adds 'announcement' for the new admin broadcast feature.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('order', 'delivery', 'payment', 'system', 'promotion', 'message', 'announcement'));
