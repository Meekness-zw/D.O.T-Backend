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
import { settlementForOrder, reconcile } from './settlementService.js';

const supabase = supabaseAdmin;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Statuses where a courier is holding a job and their position matters. */
const ACTIVE_STATUSES = [
  'assigned', 'courier_arrived', 'merchant_confirmed',
  'picked_up', 'in_transit', 'delivery_confirmation_pending',
];

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
  tax, total_amount, store_id, courier_id,
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
    earned: money(acc.earned + s.courier.amount_due),
  }), { deliveries: 0, fees: 0, earned: 0 });

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

/**
 * Live fleet: every courier currently on a job, where they were last seen,
 * and what they are carrying.
 *
 * Position is read off the order rather than a separate courier row because
 * that is where the courier app reports it (PATCH /courier/orders/:id/location).
 * There is a delivery_tracking table in the schema that nothing has ever
 * written to; using it here would mean showing an empty map.
 *
 * A courier with two active orders appears once, positioned by their most
 * recently updated one — they are one person on one motorbike, and drawing
 * them twice would overstate the size of the fleet on screen.
 */
export async function getFleet({ companyId } = {}) {
  if (!supabase) throw new Error('Server not configured');

  const { data: orders, error } = await supabase
    .from('orders')
    .select(`id, order_number, status, courier_id, store_id,
             courier_latitude, courier_longitude, courier_location_updated_at,
             pickup_address, pickup_latitude, pickup_longitude,
             delivery_address, delivery_latitude, delivery_longitude,
             created_at, delivery_fee,
             stores ( id, store_name )`)
    .in('status', ACTIVE_STATUSES)
    .not('courier_id', 'is', null)
    .order('courier_location_updated_at', { ascending: false });
  if (error) throw new Error(error.message || 'Failed to load fleet');

  const courierIds = [...new Set((orders || []).map((o) => o.courier_id).filter(Boolean))];
  if (!courierIds.length) return { couriers: [], jobs: [], generated_at: new Date().toISOString() };

  const [{ data: couriers }, { data: companies }] = await Promise.all([
    supabase.from('couriers')
      .select(`id, is_online, rating, company_id, total_deliveries,
               user_profiles ( full_name, phone, profile_photo )`)
      .in('id', courierIds),
    supabase.from('courier_companies').select('id, name, is_active'),
  ]);

  const companyById = new Map((companies || []).map((c) => [c.id, c]));
  const byCourier = new Map();

  for (const o of orders || []) {
    const existing = byCourier.get(o.courier_id);
    // The list is already ordered by freshest position, so the first row for
    // a courier is the one to place them by.
    if (!existing) byCourier.set(o.courier_id, { position_from: o, jobs: [o] });
    else existing.jobs.push(o);
  }

  const now = Date.now();
  const fleet = (couriers || [])
    .filter((c) => byCourier.has(c.id))
    .map((c) => {
      const { position_from: pos, jobs } = byCourier.get(c.id);
      const seenAt = pos.courier_location_updated_at ? new Date(pos.courier_location_updated_at).getTime() : null;
      const ageMinutes = seenAt ? Math.round((now - seenAt) / 60000) : null;
      const company = c.company_id ? companyById.get(c.company_id) : null;

      return {
        courier_id: c.id,
        name: c.user_profiles?.full_name || 'Courier',
        phone: c.user_profiles?.phone || null,
        rating: c.rating != null ? Number(c.rating) : null,
        is_online: !!c.is_online,
        company: company ? { id: company.id, name: company.name, is_active: company.is_active } : null,
        latitude: pos.courier_latitude != null ? Number(pos.courier_latitude) : null,
        longitude: pos.courier_longitude != null ? Number(pos.courier_longitude) : null,
        last_seen: pos.courier_location_updated_at || null,
        // A position an hour old is not a location, it is a memory. Flagged
        // rather than hidden: "we have lost this rider" is information the
        // person supervising needs, and dropping the pin would just look
        // like they went off shift.
        stale: ageMinutes == null || ageMinutes > 15,
        last_seen_minutes: ageMinutes,
        active_jobs: jobs.map((j) => ({
          order_id: j.id,
          order_number: j.order_number,
          status: j.status,
          store_name: j.stores?.store_name || null,
          pickup_address: j.pickup_address,
          delivery_address: j.delivery_address,
          pickup: j.pickup_latitude != null ? { lat: Number(j.pickup_latitude), lng: Number(j.pickup_longitude) } : null,
          dropoff: j.delivery_latitude != null ? { lat: Number(j.delivery_latitude), lng: Number(j.delivery_longitude) } : null,
          since: j.created_at,
        })),
      };
    })
    .filter((c) => !companyId || c.company?.id === companyId);

  return {
    couriers: fleet,
    counts: {
      on_job: fleet.length,
      positioned: fleet.filter((c) => c.latitude != null && !c.stale).length,
      stale: fleet.filter((c) => c.latitude == null || c.stale).length,
    },
    generated_at: new Date().toISOString(),
  };
}

/**
 * One order in full: who ordered it, what was in it at what price, where it
 * went, what happened to it, and how the money splits.
 *
 * Works for any order at any status, unlike settlementDetail, which is scoped
 * to money that has actually been collected. An admin looking into a
 * complaint needs to open a cancelled or unpaid order too, and getting a 404
 * on the exact order someone is asking about is the wrong answer.
 */
export async function getOrderDetail(orderId) {
  if (!supabase) throw new Error('Server not configured');

  const { data: order, error } = await supabase
    .from('orders')
    .select(`id, order_number, status, payment_status, payment_method, created_at,
             updated_at, actual_delivery_time, estimated_delivery_time,
             subtotal, delivery_fee, customer_delivery_fee, dot_delivery_subsidy,
             tax, total_amount, discount_code, delivery_notes,
             pickup_address, delivery_address, delivery_code,
             courier_latitude, courier_longitude, courier_location_updated_at,
             customer_id, courier_id, store_id,
             stores ( id, store_name, merchant_id, phone, address_line1, city )`)
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load order');
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const [{ data: items }, { data: history }, { data: customer }, { data: courier }] = await Promise.all([
    supabase.from('order_items')
      .select('id, product_id, product_name, product_price, quantity, subtotal, special_instructions')
      .eq('order_id', orderId),
    supabase.from('order_status_history')
      .select('status, notes, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),
    order.customer_id
      ? supabase.from('user_profiles').select('id, full_name, phone, email').eq('id', order.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.courier_id
      ? supabase.from('couriers')
          .select('id, rating, company_id, user_profiles ( full_name, phone )')
          .eq('id', order.courier_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let company = null;
  if (courier?.company_id) {
    const { data } = await supabase.from('courier_companies')
      .select('id, name, is_active').eq('id', courier.company_id).maybeSingle();
    company = data || null;
  }

  const settlement = settlementForOrder({ ...order, store: order.stores });

  // Line totals are recomputed from price × quantity and compared with the
  // stored subtotal. A mismatch means the row was written wrong or a price
  // moved underneath it, and an admin resolving a billing complaint needs to
  // see that rather than be handed a tidy number that does not add up.
  const lines = (items || []).map((i) => {
    const computed = money(Number(i.product_price) * Number(i.quantity));
    const stored = i.subtotal != null ? money(i.subtotal) : null;
    return {
      ...i,
      line_total: stored ?? computed,
      mismatch: stored != null && Math.abs(stored - computed) >= 0.01 ? { stored, computed } : null,
    };
  });
  const itemsTotal = money(lines.reduce((a, l) => a + l.line_total, 0));

  return {
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      payment_method: order.payment_method,
      created_at: order.created_at,
      delivered_at: order.actual_delivery_time,
      estimated_delivery_time: order.estimated_delivery_time,
      discount_code: order.discount_code,
      delivery_notes: order.delivery_notes,
      pickup_address: order.pickup_address,
      delivery_address: order.delivery_address,
    },
    customer: customer || null,
    store: order.stores || null,
    courier: courier
      ? {
          id: courier.id,
          name: courier.user_profiles?.full_name || null,
          phone: courier.user_profiles?.phone || null,
          rating: courier.rating != null ? Number(courier.rating) : null,
          company,
          // Where money for this delivery goes, said plainly so the
          // accountant does not have to re-derive the company rule.
          pays_to: company ? 'company' : 'courier',
          last_position: order.courier_latitude != null
            ? {
                lat: Number(order.courier_latitude),
                lng: Number(order.courier_longitude),
                at: order.courier_location_updated_at,
              }
            : null,
        }
      : null,
    items: lines,
    items_total: itemsTotal,
    items_reconcile: Math.abs(itemsTotal - money(order.subtotal)) < 0.02,
    settlement,
    reconciliation: reconcile(settlement),
    history: history || [],
  };
}
