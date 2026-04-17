-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Adds is_default column to business_types so featured categories sort to the top.

ALTER TABLE business_types
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
