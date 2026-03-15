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

/** Last 7 days: orders and signups per day for charts */
export async function getAdminStatsCharts() {
  if (!supabase) throw new Error('Server not configured');

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = new Date(d);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setUTCHours(23, 59, 59, 999);
    days.push({
      date: start.toISOString().slice(0, 10),
      label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      start: start.toISOString(),
      end: end.toISOString(),
    });
  }

  const ordersByDay = await Promise.all(
    days.map(async (day) => {
      const { count } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', day.start)
        .lte('created_at', day.end);
      return { ...day, orders: count ?? 0 };
    }),
  );

  const signupsByDay = await Promise.all(
    days.map(async (day) => {
      const { count } = await supabase
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', day.start)
        .lte('created_at', day.end);
      return { ...day, signups: count ?? 0 };
    }),
  );

  return {
    ordersByDay: ordersByDay.map(({ date, label, orders }) => ({ date, label, orders })),
    signupsByDay: signupsByDay.map(({ date, label, signups }) => ({ date, label, signups })),
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
  const users = data || [];

  // Attach all roles from user_roles (multi-role support); fallback to profile.role
  if (users.length > 0) {
    const ids = users.map((u) => u.id);
    const { data: roleRows } = await supabase
      .from('user_roles')
      .select('user_id, role')
      .in('user_id', ids);
    const rolesByUserId = new Map();
    (roleRows || []).forEach((r) => {
      if (!rolesByUserId.has(r.user_id)) rolesByUserId.set(r.user_id, []);
      rolesByUserId.get(r.user_id).push(r.role);
    });
    users.forEach((u) => {
      u.roles = rolesByUserId.get(u.id)?.length
        ? rolesByUserId.get(u.id)
        : (u.role ? [u.role] : []);
    });
  }

  return { users, total: count ?? 0 };
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
