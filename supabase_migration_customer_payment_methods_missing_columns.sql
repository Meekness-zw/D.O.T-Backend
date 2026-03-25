-- Fix: column customer_payment_methods.phone_country_code does not exist (42703)
-- Run in Supabase SQL Editor if your table predates these fields.

ALTER TABLE customer_payment_methods
  ADD COLUMN IF NOT EXISTS phone_country_code TEXT;

ALTER TABLE customer_payment_methods
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

COMMENT ON COLUMN customer_payment_methods.phone_country_code IS 'e.g. +263';
COMMENT ON COLUMN customer_payment_methods.phone_number IS 'Digits / local number for mobile money';
