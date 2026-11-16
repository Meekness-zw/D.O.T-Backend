-- One-off clean-up before launch: delete every order placed before
-- Thursday 12 November 2026 00:00 Zimbabwe time, with everything linked to
-- those orders (order items, payments, store confirmations, reviews, chat …).
-- Orders from Thursday 12 November onwards are kept.
--
-- Needs migrations/2026-11-13-admin-delete.sql to have been run first
-- (it creates public.dot_delete_where).
--
-- Not touched: wallet entries and settlements. They mention orders only by
-- text, not by a database link, so store and courier wallet balances still
-- include earnings from the deleted orders.
--
-- Run it in three steps in Supabase → SQL Editor.

-- ── Step 1: look before deleting (changes nothing) ─────────────────────────
select
  count(*) filter (where created_at <  timestamptz '2026-11-12 00:00:00+02') as orders_to_delete,
  count(*) filter (where created_at >= timestamptz '2026-11-12 00:00:00+02') as orders_kept,
  min(created_at) filter (where created_at <  timestamptz '2026-11-12 00:00:00+02') as oldest_deleted,
  max(created_at) filter (where created_at <  timestamptz '2026-11-12 00:00:00+02') as newest_deleted,
  min(created_at) filter (where created_at >= timestamptz '2026-11-12 00:00:00+02') as oldest_kept
from public.orders;

-- ── Step 2: dry run — does the delete, shows what went, then undoes it ─────
begin;
select public.dot_delete_where(
  'public.orders'::regclass,
  $$created_at < timestamptz '2026-11-12 00:00:00+02'$$,
  '{}',
  '{}'::jsonb
) as would_delete;
select count(*) as orders_left_after from public.orders;
rollback;

-- ── Step 3: the real delete (run on its own once steps 1–2 look right) ─────
-- begin;
-- select public.dot_delete_where(
--   'public.orders'::regclass,
--   $$created_at < timestamptz '2026-11-12 00:00:00+02'$$,
--   '{}',
--   '{}'::jsonb
-- ) as deleted;
-- select count(*) as orders_left from public.orders;
-- commit;
