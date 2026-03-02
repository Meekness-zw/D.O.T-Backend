-- Onboarding migration: courier extra fields + merchant documents table
-- Run in Supabase SQL Editor.

ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS drivers_license_number TEXT,
  ADD COLUMN IF NOT EXISTS drivers_license_expiry DATE;

CREATE TABLE IF NOT EXISTS merchant_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('owner_id', 'business_certificate', 'proof_of_address')),
  document_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Note:
-- Create public storage buckets in Supabase Dashboard → Storage:
-- - courier-documents
-- - store-logos
-- - merchant-documents

