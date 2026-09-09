/**
 * Everything the admin, accountant and marketing dashboards need to supervise
 * a merchant or a courier from one screen.
 *
 * Kept separate from getAdminMerchantDetail / getAdminCourierDetail, which the
 * approvals queue depends on. Those answer "should this application be let
 * in"; these answer "how is this account doing". Widening the approval
 * functions to carry sales history would make an approval screen pay for
 * queries it never reads, and would put the queue at risk of a change made
 * for a reporting reason.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { getWalletBalance } from './walletLedger.js';
import { settlementForOrder } from './settlementService.js';

const supabase = supabaseAdmin;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Bucket key for a date, at day / week / month resolution.
 *
 * Weeks start Monday and are keyed by that Monday's date rather than by an
 * ISO week number: "2026-09-07" is directly comparable and sortable as a
 * string, where "2026-W37" needs a decoder before it means anything on screen.
 */
export function bucketKey(dateish, period) {
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  if (period === 'monthly') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (period === 'weekly') {
    const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // getUTCDay(): 0 = Sunday. Shift so Monday is the start of the week.
    const shift = (copy.getUTCDay() + 6) % 7;
    copy.setUTCDate(copy.getUTCDate() - shift);
    return copy.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/** Groups settled orders into day/week/month totals. */
function summarise(settlements, period, pick) {
  const buckets = new Map();
  for (const s of settlements) {
    const key = bucketKey(s.delivered_at || s.created_at, period);
    if (!key) continue;
    const b = buckets.get(key) || { period: key, orders: 0, gross: 0, net: 0 };
    b.orders += 1;
    b.gross = money(b.gross + s.customer_paid);
    b.net = money(b.net + pick(s));
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => (a.period < b.period ? 1 : -1));
}

const ORDER_COLS = `id, order_number, created_at, actual_delivery_time, status, payment_status,
  payment_method, subtotal, delivery_fee, customer_delivery_fee, dot_delivery_subsidy,
  tax, courier_tip, total_amount, store_id, courier_id,
  pickup_address, delivery_address`;

/**
 * A merchant, end to end: business, stores, opening hours, products, banking,
 * wallet balance, and sales bucketed by the requested period.
 */
export async function getMerchantOversight(merchantId, { period = 'daily', from, to } = {}) {
  if (!supabase) throw new Error('Server not configured');

  const { data: merchant, error: mErr } = await supabase
    .from('merchants')
    .select(`id, business_name, business_type, business_registration_number, tax_id,
             is_verified, is_active, approval_status, created_at,
             user_profiles ( full_name, email, phone )`)
    .eq('id', merchantId)
    .maybeSingle();
  if (mErr) throw new Error(mErr.message || 'Failed to load merchant');
  if (!merchant) { const e = new Error('Merchant not found'); e.status = 404; throw e; }

  const { data: stores } = await supabase
    .from('stores')
    .select(`id, store_name, phone, email, address_line1, address_line2, city, state_province,
             postal_code, country, latitude, longitude, operating_hours, is_open, is_active,
             rating, delivery_radius_km, created_at`)
    .eq('merchant_id', merchantId);

  const storeIds = (stores || []).map((s) => s.id);

  const [{ data: products }, { data: payoutMethods }, balance] = await Promise.all([
    storeIds.length
      ? supabase.from('products')
          .select('id, store_id, name, description, price, is_available, stock_quantity, category, image_url, created_at')
          .in('store_id', storeIds)
          .order('name')
      : Promise.resolve({ data: [] }),
    supabase.from('merchant_payout_methods')
      .select('id, method_type, provider, provider_code, account_number, account_name, is_default, is_verified')
      .eq('merchant_id', merchantId),
    getWalletBalance(merchantId, 'merchant'),
  ]);

  let ordersQuery = supabase
    .from('orders')
    .select(ORDER_COLS)
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (storeIds.length) ordersQuery = ordersQuery.in('store_id', storeIds);
  if (from) ordersQuery = ordersQuery.gte('created_at', from);
  if (to) ordersQuery = ordersQuery.lte('created_at', to);
  const { data: orders } = storeIds.length ? await ordersQuery : { data: [] };

  const storeById = new Map((stores || []).map((s) => [s.id, s]));
  const settlements = (orders || []).map((o) =>
    settlementForOrder({ ...o, store: { ...storeById.get(o.store_id), merchant_id: merchantId } }));

  const delivered = settlements.filter((s) => s.status === 'delivered');
  const totals = delivered.reduce((acc, s) => ({
    orders: acc.orders + 1,
    gross: money(acc.gross + s.customer_paid),
    earned: money(acc.earned + s.store.amount_due),
    dot_markup: money(acc.dot_markup + s.store.dot_markup),
  }), { orders: 0, gross: 0, earned: 0, dot_markup: 0 });

  return {
    merchant,
    stores: stores || [],
    products: products || [],
    payout_methods: payoutMethods || [],
    balance: money(balance),
    period,
    sales: summarise(delivered, period, (s) => s.store.amount_due),
    totals,
    recent_orders: settlements.slice(0, 50),
  };
}

/**
 * A courier, end to end: profile, company, vehicles, payout destination,
 * balance, earnings by period, deliveries and the routes they run most.
 */
export async function getCourierOversight(courierId, { period = 'daily', from, to } = {}) {
  if (!supabase) throw new Error('Server not configured');

  const { data: courier, error: cErr } = await supabase
    .from('couriers')
    .select(`id, national_id, date_of_birth, city, drivers_license_number, drivers_license_expiry,
             is_online, is_verified, verification_status, rating, total_deliveries, total_earnings,
             account_balance, company_id, created_at,
             user_profiles ( full_name, email, phone, profile_photo )`)
    .eq('id', courierId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message || 'Failed to load courier');
  if (!courier) { const e = new Error('Courier not found'); e.status = 404; throw e; }

  const [{ data: company }, { data: vehicles }, { data: payoutMethods }, balance] = await Promise.all([
    courier.company_id
      ? supabase.from('courier_companies').select('*').eq('id', courier.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('courier_vehicles')
      .select('id, vehicle_type, brand, model, year, color, license_plate, is_active')
      .eq('courier_id', courierId),
    supabase.from('courier_payout_methods')
      .select('id, method_type, provider, provider_code, account_number, account_name, is_default')
      .eq('courier_id', courierId),
    getWalletBalance(courierId, 'courier'),
  ]);

  let q = supabase.from('orders').select(ORDER_COLS)
    .eq('courier_id', courierId)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);
  const { data: orders } = await q;

  const storeIds = [...new Set((orders || []).map((o) => o.store_id).filter(Boolean))];
  const { data: storeRows } = storeIds.length
    ? await supabase.from('stores').select('id, store_name, merchant_id').in('id', storeIds)
    : { data: [] };
  const storeById = new Map((storeRows || []).map((s) => [s.id, s]));

  const settlements = (orders || []).map((o) =>
    settlementForOrder({ ...o, store: storeById.get(o.store_id) || null }));
  const delivered = settlements.filter((s) => s.status === 'delivered');

  // Routes the courier actually runs. Keyed on pickup → drop-off suburb
  // rather than the full street address: two drops on the same street are the
  // same route for planning purposes, and full addresses never repeat enough
  // to form a pattern.
  const suburb = (addr) => {
    const parts = String(addr || '').split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : (parts[0] || 'Unknown');
  };
  const routes = new Map();
  for (const o of orders || []) {
    if (o.status !== 'delivered') continue;
    const key = `${suburb(o.pickup_address)} → ${suburb(o.delivery_address)}`;
    const r = routes.get(key) || { route: key, trips: 0, earned: 0 };
    r.trips += 1;
    const s = settlements.find((x) => x.order_id === o.id);
    r.earned = money(r.earned + (s?.courier.amount_due || 0));
    routes.set(key, r);
  }

  const totals = delivered.reduce((acc, s) => ({
    deliveries: acc.deliveries + 1,
    fees: money(acc.fees + s.courier.delivery_fee_share),
    tips: money(acc.tips + s.courier.tip),
    earned: money(acc.earned + s.courier.amount_due),
  }), { deliveries: 0, fees: 0, tips: 0, earned: 0 });

  return {
    courier,
    company: company || null,
    vehicles: vehicles || [],
    payout_methods: payoutMethods || [],
    // Where money for this courier actually goes, so the dashboard does not
    // have to re-derive the company rule and get it subtly different.
    pays_to: company ? 'company' : 'courier',
    balance: money(balance),
    period,
    earnings: summarise(delivered, period, (s) => s.courier.amount_due),
    totals,
    common_routes: [...routes.values()].sort((a, b) => b.trips - a.trips).slice(0, 15),
    recent_deliveries: settlements.slice(0, 50),
  };
}
