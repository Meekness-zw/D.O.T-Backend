-- Allow deleting a user_profiles row when it is only referenced as
-- "who did this" on history and verification records.
-- Those columns stay; the user id is cleared. Order history itself is kept.
-- Run once in the Supabase SQL editor.

ALTER TABLE order_status_history
  DROP CONSTRAINT IF EXISTS order_status_history_changed_by_fkey;

ALTER TABLE order_status_history
  ADD CONSTRAINT order_status_history_changed_by_fkey
  FOREIGN KEY (changed_by) REFERENCES user_profiles(id) ON DELETE SET NULL;

ALTER TABLE merchant_documents
  DROP CONSTRAINT IF EXISTS merchant_documents_verified_by_fkey;

ALTER TABLE merchant_documents
  ADD CONSTRAINT merchant_documents_verified_by_fkey
  FOREIGN KEY (verified_by) REFERENCES user_profiles(id) ON DELETE SET NULL;

ALTER TABLE courier_documents
  DROP CONSTRAINT IF EXISTS courier_documents_verified_by_fkey;

ALTER TABLE courier_documents
  ADD CONSTRAINT courier_documents_verified_by_fkey
  FOREIGN KEY (verified_by) REFERENCES user_profiles(id) ON DELETE SET NULL;
