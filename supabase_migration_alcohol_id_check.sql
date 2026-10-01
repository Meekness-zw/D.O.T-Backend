-- Save the customer ID photo a courier takes when an alcohol order is handed over.
-- Run once in the Supabase SQL editor.

alter table public.orders
  add column if not exists customer_id_photo_url text;

comment on column public.orders.customer_id_photo_url is
  'Photo of the customer ID collected at handover when the order includes alcohol.';
