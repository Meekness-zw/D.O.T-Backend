/**
 * Admin dashboard: stats, users, orders, deliveries, payments.
 * Uses supabaseAdmin; call only from admin-protected routes.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';

const supabase = supabaseAdmin;

export async function getAdminStats() {
  if (!supabase) throw new Error('Server not configured');

  const [
    { count: totalUsers },
    { count: totalOrders },
    { count: deliveredOrders },
    { count: totalStores },
    { count: totalCouriers },
  ] = await Promise.all([
    supabase.from('user_profiles').select('*', { count: 'exact', head: true }),
    supabase.from('orders').select('*', { count: 'exact', head: true }),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'delivered'),
    supabase.from('stores').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('couriers').select('*', { count: 'exact', head: true }),
  ]);

  // Revenue: sum of total_amount for delivered/paid orders
  const { data: revenueRows } = await supabase
    .from('orders')
    .select('total_amount')
    .in('status', ['delivered', 'in_transit', 'picked_up', 'ready', 'preparing', 'confirmed', 'assigned', 'pending'])
    .eq('payment_status', 'paid');
  const totalRevenue = (revenueRows || []).reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  // Signups in last 7 days
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { count: signupsLast7Days } = await supabase
    .from('user_profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', weekAgo.toISOString());

  // Orders last 7 days
  const { count: ordersLast7Days } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', weekAgo.toISOString());

  return {
    totalUsers: totalUsers ?? 0,
    totalOrders: totalOrders ?? 0,
    deliveredOrders: deliveredOrders ?? 0,
    totalStores: totalStores ?? 0,
    totalCouriers: totalCouriers ?? 0,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    signupsLast7Days: signupsLast7Days ?? 0,
    ordersLast7Days: ordersLast7Days ?? 0,
  };
}

export async function getAdminUsers(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0, role, search } = options;

  let query = supabase
    .from('user_profiles')
    .select('id, email, phone, full_name, role, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (role) query = query.eq('role', role);
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    query = query.or(`full_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message || 'Failed to fetch users');
  return { users: data || [], total: count ?? 0 };
}

export async function getAdminOrders(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0, status, from, to } = options;

  let query = supabase
    .from('orders')
    .select(`
      id,
      order_number,
      status,
      payment_status,
      total_amount,
      payment_method,
      delivery_address,
      created_at,
      actual_delivery_time,
      store_id,
      customer_id,
      courier_id,
      stores ( store_name )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message || 'Failed to fetch orders');

  const orders = (data || []).map((o) => ({
    ...o,
    store_name: o.stores?.store_name ?? (Array.isArray(o.stores) ? o.stores[0]?.store_name : null),
  }));

  if (orders.length > 0) {
    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, phone')
      .in('id', customerIds);
    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    orders.forEach((o) => {
      const p = profileMap.get(o.customer_id);
      o.customer_name = p?.full_name ?? null;
      o.customer_phone = p?.phone ?? null;
    });
  }
  return { orders, total: count ?? 0 };
}

export async function getAdminDeliveries(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data: orders, error: ordersError, count } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      status,
      total_amount,
      delivery_address,
      created_at,
      actual_delivery_time,
      courier_id,
      store_id,
      customer_id,
      stores ( store_name )
    `, { count: 'exact' })
    .in('status', ['assigned', 'picked_up', 'in_transit', 'delivered'])
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (ordersError) throw new Error(ordersError.message || 'Failed to fetch deliveries');

  const deliveries = (orders || []).map((o) => ({
    ...o,
    store_name: o.stores?.store_name ?? (Array.isArray(o.stores) ? o.stores[0]?.store_name : null),
  }));

  if (deliveries.length > 0) {
    const customerIds = [...new Set(deliveries.map((o) => o.customer_id).filter(Boolean))];
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, phone')
      .in('id', customerIds);
    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    deliveries.forEach((o) => {
      const p = profileMap.get(o.customer_id);
      o.customer_name = p?.full_name ?? null;
      o.customer_phone = p?.phone ?? null;
    });
  }
  return { deliveries, total: count ?? 0 };
}

export async function getAdminPayments(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, amount, currency, payment_method, payment_provider, status, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch payments');
  return { payments: data || [], total: count ?? 0 };
}

export async function getAdminStores(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('stores')
    .select('id, store_name, merchant_id, city, is_active, rating, total_reviews, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch stores');
  return { stores: data || [], total: count ?? 0 };
}

export async function getAdminMerchants(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('merchants')
    .select(`
      id,
      business_name,
      business_type,
      is_verified,
      is_active,
      created_at,
      user_profiles ( full_name, email, phone )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch merchants');
  return { merchants: data || [], total: count ?? 0 };
}

export async function getAdminCouriers(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('couriers')
    .select(`
      id,
      is_online,
      is_verified,
      verification_status,
      rating,
      total_deliveries,
      total_earnings,
      account_balance,
      created_at,
      user_profiles ( full_name, email, phone )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch couriers');
  return { couriers: data || [], total: count ?? 0 };
}
