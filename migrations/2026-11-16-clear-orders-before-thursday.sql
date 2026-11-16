-- One-off clean-up before launch (Zimbabwe time):
--
--   Before Thursday 12 November 2026 → every order, payment and wallet entry goes.
--   On Thursday 12 November          → orders and payments NOT paid by EcoCash go,
--                                      with the wallet entries made for them.
--   From Friday 13 November on       → nothing is touched.
--
-- Everything linked to a removed order or payment goes with it (order items,
-- store confirmations, reviews, chat …). Wallet balances are recalculated so
-- every remaining wallet reads as if the removed entries never happened.
--
-- Needs migrations/2026-11-13-admin-delete.sql to have been run first
-- (it creates public.dot_delete_where).
--
-- HOW TO RUN (Supabase → SQL Editor): paste this whole file and run it.
--   As written, the very last line runs a PREVIEW: it does the whole clean-up,
--   shows what went and the new wallet balances, then undoes it. Nothing changes.
--   When the preview looks right, edit ONLY the very last line of the file,
--   changing (false) to (true), and run it again.
--
-- Not touched: settlements and withdrawal requests (payout records), stores,
-- products and accounts.

create or replace function pg_temp.dot_cleanup(p_apply boolean)
returns table(what text, detail text)
language plpgsql
as $$
declare
  n_orders_before int;
  n_orders_thu int;
  n_orders_kept int;
  n_payments int;
  n_wallet int;
  n_wallets_changed int;
  linked_payments jsonb := '{}'::jsonb;
  linked_orders jsonb := '{}'::jsonb;
begin
  drop table if exists dot_del_orders, dot_del_payments, dot_wallet, dot_wallet_kept;

  -- What goes. (Literal dates: PL/pgSQL can't put variables in CREATE TABLE AS.)
  create temp table dot_del_orders as
    select id, created_at from public.orders
    where created_at < timestamptz '2026-11-12 00:00:00+02'
       or (created_at < timestamptz '2026-11-13 00:00:00+02'
           and coalesce(payment_method, '') <> 'ecocash');

  create temp table dot_del_payments as
    select id from public.payments
    where created_at < timestamptz '2026-11-12 00:00:00+02'
       or order_id in (select id from dot_del_orders)
       or (created_at >= timestamptz '2026-11-12 00:00:00+02'
           and created_at < timestamptz '2026-11-13 00:00:00+02'
           and coalesce(payment_method, '') <> 'ecocash');

  -- Every wallet entry with what it added to (or took from) its wallet, worked
  -- out from the running balance, and whether it goes.
  create temp table dot_wallet as
    select w.id, w.user_id, w.user_type, w.created_at, w.balance_after,
      w.balance_after - coalesce(lag(w.balance_after) over (
        partition by w.user_id, w.user_type order by w.created_at, w.id), 0) as contribution,
      (w.created_at < timestamptz '2026-11-12 00:00:00+02'
        or w.reference_id::text in (select id::text from dot_del_orders)
        or w.reference_id::text in (select id::text from dot_del_payments)) as remove
    from public.wallet_transactions w;

  -- Each remaining entry's balance, less everything removed before it.
  create temp table dot_wallet_kept as
    select k.id, k.user_id, k.user_type, k.created_at, k.balance_after,
      (select coalesce(sum(d.contribution), 0) from dot_wallet d
        where d.remove and d.user_id = k.user_id and d.user_type = k.user_type
          and (d.created_at, d.id) <= (k.created_at, k.id)) as shift
    from dot_wallet k
    where not k.remove;

  select count(*) filter (where created_at < timestamptz '2026-11-12 00:00:00+02'),
         count(*) filter (where created_at >= timestamptz '2026-11-12 00:00:00+02')
    into n_orders_before, n_orders_thu
    from dot_del_orders;
  select count(*) into n_orders_kept from public.orders where id not in (select id from dot_del_orders);
  select count(*) into n_payments from dot_del_payments;
  select count(*) into n_wallet from dot_wallet where remove;

  begin
    update public.wallet_transactions w
       set balance_after = k.balance_after - k.shift
      from dot_wallet_kept k
     where w.id = k.id and k.shift <> 0;
    get diagnostics n_wallets_changed = row_count;

    delete from public.wallet_transactions where id in (select id from dot_wallet where remove);

    linked_payments := public.dot_delete_where('public.payments'::regclass,
      'id in (select id from dot_del_payments)', '{}', '{}'::jsonb);
    linked_orders := public.dot_delete_where('public.orders'::regclass,
      'id in (select id from dot_del_orders)', '{}', '{}'::jsonb);

    if not p_apply then
      raise exception 'dot_dry_run';
    end if;
  exception
    when raise_exception then
      if sqlerrm <> 'dot_dry_run' then
        raise;
      end if;
  end;

  return query
    select 'MODE', case when p_apply then 'APPLIED — the clean-up has been made' else 'PREVIEW — nothing was changed' end
    union all select 'Orders before Thu 12 Nov', n_orders_before::text || ' deleted'
    union all select 'Non-EcoCash orders on Thu 12 Nov', n_orders_thu::text || ' deleted'
    union all select 'Orders kept', n_orders_kept::text
    union all select 'Payments', n_payments::text || ' deleted'
    union all select 'Wallet entries', n_wallet::text || ' deleted, ' || n_wallets_changed::text || ' later entries re-balanced'
    union all select 'Linked to the deleted orders', linked_orders::text
    union all select 'Linked to the deleted payments', linked_payments::text;

  -- Every wallet whose balance changes: old → new.
  return query
    with old_bal as (
      select distinct on (user_id, user_type) user_id, user_type, balance_after
      from dot_wallet order by user_id, user_type, created_at desc, id desc
    ), new_bal as (
      select distinct on (user_id, user_type) user_id, user_type, balance_after - shift as balance
      from dot_wallet_kept order by user_id, user_type, created_at desc, id desc
    )
    select
      'Wallet: ' || coalesce(p.full_name, p.phone, o.user_id::text) || ' (' || o.user_type || ')',
      '$' || to_char(o.balance_after, 'FM999999990.00') || ' → $' || to_char(coalesce(n.balance, 0), 'FM999999990.00')
    from old_bal o
    left join new_bal n on n.user_id = o.user_id and n.user_type = o.user_type
    left join public.user_profiles p on p.id = o.user_id
    where o.balance_after is distinct from coalesce(n.balance, 0)
    order by 1;
end;
$$;

select * from pg_temp.dot_cleanup(false);
