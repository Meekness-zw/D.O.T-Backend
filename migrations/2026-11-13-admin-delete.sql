-- Admin delete: permanently remove an account (customer, courier, merchant) or
-- a store, together with everything that points at it — orders, order items,
-- payments, wallet entries, products, reviews, documents and so on.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
--
-- How it works
--   dot_delete_where(table, where) deletes the matching rows of `table`, first
--   deleting (recursively) every row in a public table that references them
--   through a foreign key. Links declared ON DELETE SET NULL / SET DEFAULT are
--   left to the database (those rows survive, unlinked). It does not need a
--   list of tables, so new tables are covered automatically.
--
--   dot_admin_delete(kind, id, dry_run) is what the backend calls:
--     kind = 'account' → the login (auth.users) and everything under it,
--                        including the orders they placed or delivered and
--                        their stores' orders.
--     kind = 'store'   → the store, its orders and everything under them.
--   With dry_run = true nothing is deleted: the deletes run, the counts are
--   recorded, and the work is rolled back. That is the preview the dashboard
--   shows before you confirm.
--
--   The whole call is one transaction: if anything fails (for example a row
--   the function can't remove), nothing at all is deleted.

create or replace function public.dot_delete_where(
  p_table regclass,
  p_where text,
  p_path regclass[],
  p_counts jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fk record;
  n bigint;
begin
  if coalesce(array_length(p_path, 1), 0) >= 10 then
    raise exception 'dot_delete: links go too deep at %', p_table;
  end if;

  for fk in
    select
      c.conrelid::regclass as child,
      c.confdeltype as on_delete,
      (select string_agg(format('%I', a.attname), ', ' order by k.ord)
         from unnest(c.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
      (select string_agg(format('%I', a.attname), ', ' order by k.ord)
         from unnest(c.confkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    where c.contype = 'f'
      and c.confrelid = p_table
      and ns.nspname = 'public'
  loop
    -- SET NULL / SET DEFAULT: the database keeps those rows and clears the link.
    continue when fk.on_delete in ('n', 'd');
    -- A table already being deleted higher up (a cycle): its rows go there.
    continue when fk.child = any(p_path) and fk.child <> p_table;
    if fk.child = p_table then
      -- Self-reference (e.g. a parent row): delete the referencing rows first,
      -- but only one level, so a chain can't loop forever.
      continue when p_table = any(p_path);
    end if;
    p_counts := public.dot_delete_where(
      fk.child,
      format('(%s) in (select %s from %s where %s)', fk.child_cols, fk.parent_cols, p_table, p_where),
      p_path || p_table,
      p_counts
    );
  end loop;

  execute format('delete from %s where %s', p_table, p_where);
  get diagnostics n = row_count;
  if n > 0 then
    p_counts := jsonb_set(
      p_counts,
      array[p_table::text],
      to_jsonb(coalesce((p_counts ->> p_table::text)::bigint, 0) + n)
    );
  end if;
  return p_counts;
end;
$$;

create or replace function public.dot_admin_delete(
  p_kind text,
  p_id uuid,
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  counts jsonb := '{}'::jsonb;
begin
  if p_kind not in ('account', 'store') then
    raise exception 'dot_admin_delete: unknown kind %', p_kind;
  end if;
  if p_id is null then
    raise exception 'dot_admin_delete: id is required';
  end if;

  begin
    if p_kind = 'store' then
      if not exists (select 1 from public.stores where id = p_id) then
        raise exception 'dot_not_found';
      end if;
      counts := public.dot_delete_where('public.orders'::regclass,
        format('store_id = %L', p_id), '{}', counts);
      counts := public.dot_delete_where('public.stores'::regclass,
        format('id = %L', p_id), '{}', counts);
    else
      if not exists (select 1 from auth.users where id = p_id)
         and not exists (select 1 from public.user_profiles where id = p_id) then
        raise exception 'dot_not_found';
      end if;
      -- Orders they placed, delivered, or that went to their stores.
      counts := public.dot_delete_where('public.orders'::regclass,
        format('customer_id = %1$L or courier_id = %1$L or store_id in (select id from public.stores where merchant_id = %1$L)', p_id),
        '{}', counts);
      -- Their profile and role rows (an account may exist here without a login).
      counts := public.dot_delete_where('public.user_profiles'::regclass,
        format('id = %L', p_id), '{}', counts);
      -- The login itself; auth's own tables (sessions, identities…) cascade.
      counts := public.dot_delete_where('auth.users'::regclass,
        format('id = %L', p_id), '{}', counts);
    end if;

    if p_dry_run then
      raise exception 'dot_dry_run';
    end if;
  exception
    when raise_exception then
      if sqlerrm <> 'dot_dry_run' then
        raise;
      end if;
  end;

  return jsonb_build_object('dry_run', p_dry_run, 'deleted', counts);
end;
$$;

-- Only the backend (service role) may call these.
revoke all on function public.dot_delete_where(regclass, text, regclass[], jsonb) from public, anon, authenticated;
revoke all on function public.dot_admin_delete(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.dot_admin_delete(text, uuid, boolean) to service_role;
grant execute on function public.dot_delete_where(regclass, text, regclass[], jsonb) to service_role;
