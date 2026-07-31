-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- Fixes two related bugs in courier_documents:
--
-- 1. National ID photos had no enum slot of their own, so onboarding jammed
--    them into 'id_drivers_license' — the SAME type used for the driver's
--    license front AND back photos. That's 3 separate uploads all sharing one
--    type, which is why couriers were seeing "id drivers license" repeated
--    3 times in the Documents screen instead of one "Driver's License" row
--    and one "National ID" row.
-- 2. There was no unique constraint on (courier_id, document_type), so
--    recordCourierProfilePhotoDocument()'s upsert (userService.js) has been
--    silently failing every time a courier updates their profile photo via
--    the generic profile-update endpoint (caught and logged, never surfaced).
--
-- Part 1: Collapse existing duplicate rows down to one per (courier_id,
-- document_type) — keep the most recently created row, drop the rest — so
-- the unique constraint below can actually be created.
DELETE FROM courier_documents a
  USING courier_documents b
  WHERE a.courier_id = b.courier_id
    AND a.document_type = b.document_type
    AND a.created_at < b.created_at;

-- Part 2: Enforce one row per (courier_id, document_type) going forward, and
-- let the backend use a real upsert instead of insert / delete-then-insert.
ALTER TABLE courier_documents
  ADD CONSTRAINT courier_documents_courier_id_document_type_key
  UNIQUE (courier_id, document_type);

-- Part 3: Add 'national_id' as its own document type.
ALTER TABLE courier_documents DROP CONSTRAINT IF EXISTS courier_documents_document_type_check;
ALTER TABLE courier_documents
  ADD CONSTRAINT courier_documents_document_type_check
  CHECK (document_type IN ('id_drivers_license', 'national_id', 'vehicle_registration', 'insurance', 'profile_photo'));
