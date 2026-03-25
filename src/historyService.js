/**
 * Order history, payments, and wallet transactions for the current user.
 * Uses supabaseAdmin; all queries are scoped by userId and role.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { getProfile, getRoles } from './userService.js';

const supabase = supabaseAdmin;

/**
 * When the client passes ?role=merchant|courier|customer, honor it if the user can act in that role
 * (DB capability), not only if user_roles array includes it — avoids empty merchant orders when
 * profile.primaryRole is courier but the same user owns stores.
 */
async function resolveEffectiveRole(userId, requestedRole, userRoles, profile) {
  if (!requestedRole || !['customer', 'merchant', 'courier'].includes(requestedRole)) {
    return profile?.role ?? (userRoles?.length ? userRoles[0] : null);
  }
  if (userRoles.includes(requestedRole)) {
    return requestedRole;
  }
  if (requestedRole === 'merchant') {
    const [{ data: storeRows }, { data: merchantRow }] = await Promise.all([
      supabase.from('stores').select('id').eq('merchant_id', userId).limit(1),
      supabase.from('merchants').select('id').eq('id', userId).maybeSingle(),
    ]);
    if ((storeRows && storeRows.length > 0) || merchantRow) {
      return 'merchant';
    }
  }
  if (requestedRole === 'courier') {
    const { data: courierRow } = await supabase
      .from('couriers')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    if (courierRow) return 'courier';
  }
  if (requestedRole === 'customer') {
    const { data: customerRow } = await supabase
      .from('customers')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    if (customerRow) return 'customer';
  }
  return profile?.role ?? (userRoles?.length ? userRoles[0] : null);
}

/**
 * Get orders for the current user based on their role.
 * Supports multi-role: pass options.role to fetch orders for that role; merchant is allowed if the
 * user owns stores / has a merchants row even when JWT profile primary role is another role.
 */
export async function getOrdersForUser(userId, options = {}) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  const userRoles = await getRoles(userId);
  const effectiveRole = await resolveEffectiveRole(userId, options.role, userRoles, profile);
  if (!effectiveRole) return { orders: [], role: null };

  const { limit = 50, offset = 0, status } = options;
  let query;

  if (effectiveRole === 'customer') {
    query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        payment_status,
        subtotal,
        delivery_fee,
        tax,
        total_amount,
        payment_method,
        delivery_address,
        created_at,
        updated_at,
        store_id,
        stores ( store_name ),
        order_items (
          product_name,
          quantity,
          products (
            image_url
          )
        )
      `)
      .eq('customer_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
  } else if (effectiveRole === 'merchant') {
    const { data: storeIds } = await supabase
      .from('stores')
      .select('id')
      .eq('merchant_id', userId);
    const ids = (storeIds || []).map((s) => s.id);
    if (ids.length === 0) return { orders: [], role: 'merchant' };
    query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        payment_status,
        subtotal,
        delivery_fee,
        tax,
        total_amount,
        payment_method,
        delivery_address,
        delivery_notes,
        created_at,
        updated_at,
        store_id,
        stores ( store_name ),
        order_items (
          product_id,
          product_name,
          quantity
        )
      `)
      .in('store_id', ids)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
  } else if (effectiveRole === 'courier') {
    query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        status,
        payment_status,
        subtotal,
        delivery_fee,
        tax,
        total_amount,
        payment_method,
        delivery_address,
        created_at,
        updated_at,
        store_id,
        stores ( store_name ),
        order_items (
          product_name,
          quantity
        )
      `)
      .eq('courier_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
  } else {
    return { orders: [], role: effectiveRole };
  }

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(error.message || 'Failed to fetch orders');
  return { orders: data || [], role: effectiveRole };
}

/**
 * Get wallet transactions for the current user (any role).
 */
export async function getWalletTransactionsForUser(userId, options = {}) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const { limit = 50, offset = 0 } = options;
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('id, user_type, transaction_type, amount, balance_after, description, reference_id, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch wallet transactions');
  return data || [];
}

/**
 * Get payments for the current user. Payments table is customer_id; merchants/couriers
 * see earnings via wallet_transactions or order totals.
 */
export async function getPaymentsForUser(userId, options = {}) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  if (!profile) return [];

  if (profile.role !== 'customer') return [];

  const { limit = 50, offset = 0 } = options;
  const { data, error } = await supabase
    .from('payments')
    .select(`
      id,
      order_id,
      amount,
      currency,
      payment_method,
      payment_provider,
      transaction_id,
      status,
      created_at,
      orders (
        order_number,
        stores (
          store_name
        )
      )
    `)
    .eq('customer_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch payments');
  return data || [];
}

/**
 * Get full "me" payload: profile + roles list + role-specific rows for every role the user has.
 * Multi-role: one user can have customer, merchant, courier; all data returned so app can switch without re-fetching.
 */
export async function getFullUserMe(userId) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  if (!profile) return null;

  const roles = await getRoles(userId);
  const result = { profile, roles: roles.length > 0 ? roles : (profile.role ? [profile.role] : []) };

  if (result.roles.includes('customer')) {
    const { data } = await supabase.from('customers').select('*').eq('id', userId).single();
    result.customer = data || null;
  }
  if (result.roles.includes('merchant')) {
    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', userId)
      .single();
    result.merchant = merchant || null;
    const { data: store } = await supabase
      .from('stores')
      .select(
        'id, store_name, logo, banner_url, description, phone, email, address_line1, address_line2, city, state_province, postal_code, country, latitude, longitude, is_open, is_active, operating_hours',
      )
      .eq('merchant_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    result.store = store || null;
  }
  if (result.roles.includes('courier')) {
    const { data: courierRow } = await supabase.from('couriers').select('*').eq('id', userId).single();
    result.courier = courierRow || null;

    // Prefer courier-specific profile photo stored in courier_documents (courier storage folder)
    const { data: courierDocs } = await supabase
      .from('courier_documents')
      .select('document_type, document_url, created_at')
      .eq('courier_id', userId)
      .eq('document_type', 'profile_photo')
      .order('created_at', { ascending: false })
      .limit(1);
    const courierProfileDoc =
      Array.isArray(courierDocs) && courierDocs.length > 0 ? courierDocs[0] : null;
    if (courierProfileDoc?.document_url) {
      result.courier_profile_photo_url = courierProfileDoc.document_url;
    }
  }

  return result;
}

/**
 * Dashboard stats for merchant: KPIs, revenue by day, best-selling products, category counts.
 * All data from DB for the merchant's stores.
 */
export async function getMerchantDashboardStats(userId) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  if (profile?.role !== 'merchant') {
    return {
      totalSales: 0,
      totalOrders: 0,
      avgOrderValue: 0,
      openOrders: 0,
      revenueByDay: [],
      bestProducts: [],
      categoryCounts: [],
    };
  }

  const { data: storeRows } = await supabase
    .from('stores')
    .select('id')
    .eq('merchant_id', userId);
  const storeIds = (storeRows || []).map((s) => s.id);
  if (storeIds.length === 0) {
    return {
      totalSales: 0,
      totalOrders: 0,
      avgOrderValue: 0,
      openOrders: 0,
      revenueByDay: buildEmptyRevenueByDay(),
      bestProducts: [],
      categoryCounts: [],
    };
  }

  const now = new Date();
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const fromIso = ninetyDaysAgo.toISOString();

  const { data: orders, error: ordersError } = await supabase
    .from('orders')
    .select(
      `
      id,
      status,
      total_amount,
      created_at,
      order_items (
        product_id,
        quantity
      )
    `
    )
    .in('store_id', storeIds)
    .gte('created_at', fromIso)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (ordersError) throw new Error(ordersError.message || 'Failed to fetch orders for dashboard');
  const orderList = orders || [];

  const totalSales = orderList.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
  const totalOrders = orderList.length;
  const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
  const openOrders = orderList.filter((o) =>
    ['pending', 'confirmed', 'preparing'].includes(o.status)
  ).length;

  const revenueByDay = buildRevenueByDay(orderList);

  const soldByProductId = {};
  orderList.forEach((o) => {
    const items = o.order_items || [];
    items.forEach((item) => {
      const pid = item.product_id;
      if (pid) {
        soldByProductId[pid] = (soldByProductId[pid] || 0) + (Number(item.quantity) || 0);
      }
    });
  });

  const { data: productsData, error: productsError } = await supabase
    .from('products')
    .select(
      `
      id,
      name,
      price,
      is_available,
      image_url,
      product_categories ( name )
    `
    )
    .in('store_id', storeIds);

  if (productsError) throw new Error(productsError.message || 'Failed to fetch products for dashboard');
  const productsList = productsData || [];

  const categoryName = (p) =>
    (Array.isArray(p.product_categories)
      ? p.product_categories[0]?.name
      : p.product_categories?.name) || 'Uncategorized';

  const categoryCountsMap = {};
  productsList.forEach((p) => {
    const c = categoryName(p).trim() || 'Uncategorized';
    categoryCountsMap[c] = (categoryCountsMap[c] || 0) + 1;
  });
  const categoryCounts = Object.entries(categoryCountsMap).map(([name, value]) => ({
    name,
    value,
  }));

  const bestProducts = productsList
    .map((p) => ({
      id: p.id,
      name: p.name || '—',
      price: p.price,
      sold: soldByProductId[p.id] ?? 0,
      is_available: p.is_available,
      image_url: p.image_url,
    }))
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      sold: p.sold,
      soldLabel: p.sold > 0 ? `${p.sold} pcs` : '—',
      status: p.is_available === false ? 'Out of Stock' : 'In Stock',
      statusClass: p.is_available === false ? 'status-out' : 'status-in',
      image: p.image_url,
    }));

  return {
    totalSales,
    totalOrders,
    avgOrderValue,
    openOrders,
    revenueByDay,
    bestProducts,
    categoryCounts: categoryCounts.length
      ? categoryCounts
      : [{ name: 'No categories', value: 1 }],
  };
}

function buildEmptyRevenueByDay() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      revenue: 0,
      netIncome: 0,
    });
  }
  return days;
}

function buildRevenueByDay(orders) {
  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      revenue: 0,
      netIncome: 0,
    });
  }
  orders.forEach((o) => {
    const created = (o.created_at || '').toString().slice(0, 10);
    const amount = Number(o.total_amount) || 0;
    const row = days.find((d) => d.date === created);
    if (row) {
      row.revenue += amount;
      row.netIncome += amount * 0.7;
    }
  });
  return days;
}
