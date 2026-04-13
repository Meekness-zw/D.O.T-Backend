-- Migration: Create business_types table for dynamic business categories
-- Run this in Supabase SQL Editor

-- Enable UUID extension (required for uuid_generate_v4)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create business_types table for dynamic business categories
CREATE TABLE IF NOT EXISTS business_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  icon TEXT DEFAULT 'shopping-bag',
  is_custom BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_business_types_name ON business_types(name);

-- Seed default business types
INSERT INTO business_types (name, icon, is_custom) VALUES
  ('Restaurant / Food', 'coffee', FALSE),
  ('Grocery / Retail', 'shopping-cart', FALSE),
  ('Pharmacy', 'activity', FALSE),
  ('Hardware Store', 'settings', FALSE)
ON CONFLICT (name) DO NOTHING;