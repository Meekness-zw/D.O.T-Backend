-- Run in Supabase SQL Editor.
-- The live check rejects national_id and vehicle_photo, so saving those
-- uploads fails with courier_documents_document_type_check.
ALTER TABLE courier_documents DROP CONSTRAINT IF EXISTS courier_documents_document_type_check;
ALTER TABLE courier_documents
  ADD CONSTRAINT courier_documents_document_type_check
  CHECK (document_type IN (
    'id_drivers_license',
    'national_id',
    'vehicle_registration',
    'vehicle_photo',
    'insurance',
    'profile_photo'
  ));
