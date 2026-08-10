-- Four-digit customer-to-courier handoff code.
-- Stored as text so leading zeroes remain intact. The API only exposes this
-- value to the customer who owns the order.
alter table public.orders
  add column if not exists delivery_code text;

-- Give already-open orders a code as well, so deploying this feature does not
-- strand deliveries that were placed before the migration ran.
update public.orders
set delivery_code = lpad(floor(random() * 10000)::int::text, 4, '0')
where delivery_code is null
  and status not in ('delivered', 'completed', 'cancelled', 'refunded');

alter table public.orders
  drop constraint if exists orders_delivery_code_format;

alter table public.orders
  add constraint orders_delivery_code_format
  check (delivery_code is null or delivery_code ~ '^[0-9]{4}$');

comment on column public.orders.delivery_code is
  'Customer-visible four-digit code required from the assigned courier to complete delivery.';
