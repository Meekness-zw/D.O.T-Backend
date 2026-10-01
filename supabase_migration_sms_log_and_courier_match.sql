-- Run once in the Supabase SQL editor.
-- Creates the SMS spend log and the courier-match timestamps the API already uses.

create table if not exists public.sms_send_log (
  id bigint generated always as identity primary key,
  phone text not null,
  ip text,
  purpose text,
  blocked_reason text,
  created_at timestamptz not null default now()
);

create index if not exists sms_send_log_created_at_idx
  on public.sms_send_log (created_at);

create index if not exists sms_send_log_phone_created_at_idx
  on public.sms_send_log (phone, created_at);

create index if not exists sms_send_log_ip_created_at_idx
  on public.sms_send_log (ip, created_at);

alter table public.sms_send_log enable row level security;

alter table public.orders
  add column if not exists courier_match_started_at timestamptz,
  add column if not exists courier_match_expired_at timestamptz;

notify pgrst, 'reload schema';
