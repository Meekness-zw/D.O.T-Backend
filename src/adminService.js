/**
 * Admin dashboard: stats, users, orders, deliveries, payments.
 * Uses supabaseAdmin; call only from admin-protected routes.
 */

import axios from 'axios';
import { supabaseAdmin } from './supabaseAdminClient.js';

/** Send a push notification via Expo Push API. Silently ignores missing or invalid tokens. */
async function sendExpoPush(userId, { title, body, data = {} }) {
  if (!supabaseAdmin) return;
  try {
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('push_token')
      .eq('id', userId)
      .maybeSingle();
    const token = profile?.push_token;
    if (!token || !token.startsWith('ExponentPushToken')) return;
    await axios.post(
      'https://exp.host/push/send',
      { to: token, title, body, data, sound: 'default' },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 },
    );
  } catch (err) {
    console.warn('[Push] Failed to send notification to', userId, err?.message);
  }
}

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
    .select('id, email, phone, full_name, role, is_suspended, created_at', { count: 'exact' })
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

  // Roles: same source of truth as app `getRoles` — membership in customers / merchants / couriers,
  // plus optional `user_roles` rows, then fallback to `user_profiles.role`.
  if (users.length > 0) {
    const ids = users.map((u) => u.id);
    const ROLE_ORDER = ['customer', 'merchant', 'courier'];

    const [
      { data: customerRows },
      { data: merchantRows },
      { data: courierRows },
      { data: roleRows },
    ] = await Promise.all([
      supabase.from('customers').select('id').in('id', ids),
      supabase.from('merchants').select('id').in('id', ids),
      supabase.from('couriers').select('id').in('id', ids),
      supabase.from('user_roles').select('user_id, role').in('user_id', ids),
    ]);

    const rolesByUserId = new Map(); // id -> Set
    const add = (userId, r) => {
      if (!userId || !r) return;
      if (!rolesByUserId.has(userId)) rolesByUserId.set(userId, new Set());
      rolesByUserId.get(userId).add(String(r).toLowerCase());
    };

    (customerRows || []).forEach((row) => add(row.id, 'customer'));
    (merchantRows || []).forEach((row) => add(row.id, 'merchant'));
    (courierRows || []).forEach((row) => add(row.id, 'courier'));
    (roleRows || []).forEach((row) => add(row.user_id, row.role));

    users.forEach((u) => {
      const set = rolesByUserId.get(u.id);
      let list = set ? [...set] : [];
      if (list.length === 0 && u.role) list = [String(u.role).toLowerCase()];
      list.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
      u.roles = list;
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
    const courierIds = [...new Set(deliveries.map((o) => o.courier_id).filter(Boolean))];
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, phone')
      .in('id', [...new Set([...customerIds, ...courierIds])]);
    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    deliveries.forEach((o) => {
      const customerProfile = profileMap.get(o.customer_id);
      const courierProfile = profileMap.get(o.courier_id);
      o.customer_name = customerProfile?.full_name ?? null;
      o.customer_phone = customerProfile?.phone ?? null;
      o.courier_name = courierProfile?.full_name ?? null;
      o.courier_phone = courierProfile?.phone ?? null;
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

export async function getAdminPendingDocuments(options = {}) {
  if (!supabase) throw new Error('Server not configured');
  const { limit = 50, offset = 0 } = options;

  const { data, error, count } = await supabase
    .from('courier_documents')
    .select(
      `
      id,
      courier_id,
      document_type,
      document_url,
      status,
      created_at,
      couriers (
        id,
        verification_status,
        is_verified,
        user_profiles ( full_name, email, phone )
      )
    `,
      { count: 'exact' },
    )
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message || 'Failed to fetch pending documents');
  return { documents: data || [], total: count ?? 0 };
}

function extractBucketAndPathFromSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    // Expected patterns:
    // /storage/v1/object/public/<bucket>/<path>
    // /storage/v1/object/<bucket>/<path>
    const parts = u.pathname.split('/').filter(Boolean);
    const objectIdx = parts.findIndex((p) => p === 'object');
    if (objectIdx === -1) return null;
    const afterObject = parts.slice(objectIdx + 1);
    if (afterObject.length < 2) return null;

    const bucket = afterObject[0] === 'public' ? afterObject[1] : afterObject[0];
    const pathParts = afterObject[0] === 'public' ? afterObject.slice(2) : afterObject.slice(1);
    const path = decodeURIComponent(pathParts.join('/'));
    if (!bucket || !path) return null;
    return { bucket, path };
  } catch {
    return null;
  }
}

async function addSignedUrlToItem(item, urlKey, signedKey = 'signed_url', expiresInSeconds = 60 * 30) {
  if (!item) return item;
  const originalUrl = item[urlKey];
  const extracted = extractBucketAndPathFromSupabaseUrl(originalUrl);
  if (!extracted) return item;

  const { data, error } = await supabase.storage
    .from(extracted.bucket)
    .createSignedUrl(extracted.path, expiresInSeconds);

  if (error || !data?.signedUrl) return item;
  return { ...item, [signedKey]: data.signedUrl };
}

// Pending users (for "Approve Users" tab)
export async function getAdminPendingUsers() {
  if (!supabase) throw new Error('Server not configured');

  const [couriersRes, merchantsRes] = await Promise.all([
    supabase
      .from('couriers')
      .select(
        `
        id,
        is_verified,
        verification_status,
        created_at,
        user_profiles ( full_name, email, phone )
      `,
      )
      // neq does not match NULL — also include rows where verification_status is null
      .or('verification_status.is.null,verification_status.neq.approved'),
    supabase
      .from('merchants')
      .select(
        `
        id,
        business_name,
        business_type,
        is_verified,
        is_active,
        approval_status,
        created_at,
        user_profiles ( full_name, email, phone )
      `,
      )
      // neq does not match NULL — explicitly include null approval_status rows too
      .or('approval_status.is.null,approval_status.neq.approved'),
  ]);

  if (couriersRes.error) {
    throw new Error(couriersRes.error.message || 'Failed to fetch pending couriers');
  }
  if (merchantsRes.error) {
    throw new Error(merchantsRes.error.message || 'Failed to fetch pending merchants');
  }

  const couriers = couriersRes.data || [];
  const merchants = merchantsRes.data || [];

  // Group by user ID so a user who registered for multiple roles appears as one entry
  const userMap = new Map();

  for (const c of couriers) {
    if (!userMap.has(c.id)) {
      userMap.set(c.id, {
        userId: c.id,
        profile: c.user_profiles,
        roles: [],
        courier: null,
        merchant: null,
        created_at: c.created_at,
      });
    }
    const entry = userMap.get(c.id);
    entry.roles.push('courier');
    entry.courier = c;
    if (c.created_at && (!entry.created_at || c.created_at < entry.created_at)) {
      entry.created_at = c.created_at;
    }
  }

  for (const m of merchants) {
    if (!userMap.has(m.id)) {
      userMap.set(m.id, {
        userId: m.id,
        profile: m.user_profiles,
        roles: [],
        courier: null,
        merchant: null,
        created_at: m.created_at,
      });
    }
    const entry = userMap.get(m.id);
    entry.roles.push('merchant');
    entry.merchant = m;
    if (m.created_at && (!entry.created_at || m.created_at < entry.created_at)) {
      entry.created_at = m.created_at;
    }
  }

  return {
    users: Array.from(userMap.values()),
    couriers,
    merchants,
  };
}

// Approve a courier: mark verified and approve all their pending documents
export async function approveCourier(courierId) {
  if (!supabase) throw new Error('Server not configured');

  const { data: courier, error } = await supabase
    .from('couriers')
    .update({ is_verified: true, verification_status: 'approved' })
    .eq('id', courierId)
    .select(
      `
      id,
      is_verified,
      verification_status,
      user_profiles ( full_name, email, phone )
    `,
    )
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to approve courier');
  if (!courier) throw new Error('Courier not found');

  // Mark all their pending documents as approved
  await supabase
    .from('courier_documents')
    .update({ status: 'approved' })
    .eq('courier_id', courierId)
    .eq('status', 'pending');

  // Notify the courier
  await sendExpoPush(courierId, {
    title: 'Account Approved!',
    body: 'Your courier account has been verified. You can now start accepting deliveries.',
    data: { type: 'courier_approved' },
  });

  return courier;
}

// Approve a merchant: mark verified & active & approved
export async function approveMerchant(merchantId) {
  if (!supabase) throw new Error('Server not configured');

  const { data: merchant, error } = await supabase
    .from('merchants')
    .update({ is_verified: true, is_active: true, approval_status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', merchantId)
    .select(
      `
      id,
      business_name,
      business_type,
      is_verified,
      is_active,
      approval_status,
      user_profiles ( full_name, email, phone )
    `,
    )
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to approve merchant');
  if (!merchant) throw new Error('Merchant not found');

  // Notify the merchant
  await sendExpoPush(merchantId, {
    title: 'Account Approved!',
    body: `Your merchant account "${merchant.business_name}" has been approved. You can now start receiving orders.`,
    data: { type: 'merchant_approved' },
  });

  return merchant;
}

// Reject a merchant
export async function rejectMerchant(merchantId, reason) {
  if (!supabase) throw new Error('Server not configured');

  const { data: merchant, error } = await supabase
    .from('merchants')
    .update({ approval_status: 'rejected', rejected_reason: reason || null })
    .eq('id', merchantId)
    .select(
      `
      id,
      business_name,
      business_type,
      approval_status,
      rejected_reason,
      user_profiles ( full_name, email, phone )
    `,
    )
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to reject merchant');
  if (!merchant) throw new Error('Merchant not found');

  await sendExpoPush(merchantId, {
    title: 'Application Update',
    body: reason ? `Your merchant application was not approved: ${reason}` : 'Your merchant application was not approved. Please contact support.',
    data: { type: 'merchant_rejected' },
  });

  return merchant;
}

// Reject a courier — notify then delete all courier data so they can re-apply
export async function rejectCourier(courierId, reason) {
  if (!supabase) throw new Error('Server not configured');

  // Fetch courier info for notification before deleting
  const { data: courier, error: fetchError } = await supabase
    .from('couriers')
    .select('id, user_profiles ( full_name, email, phone )')
    .eq('id', courierId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message || 'Failed to find courier');
  if (!courier) throw new Error('Courier not found');

  // Notify the user before wiping data
  await sendExpoPush(courierId, {
    title: 'Application Declined',
    body: reason
      ? `Your courier application was declined: ${reason}. Please review the requirements and try again.`
      : 'Your courier application was declined. Please review the requirements and try again.',
    data: { type: 'courier_rejected', reason: reason || null },
  });

  // Delete related data (cascade may not cover all tables)
  await supabase.from('courier_documents').delete().eq('courier_id', courierId);
  await supabase.from('courier_vehicles').delete().eq('courier_id', courierId);
  await supabase.from('courier_payout_methods').delete().eq('courier_id', courierId);

  // Delete the courier record — user_profiles row stays so they can log in and re-apply
  const { error: deleteError } = await supabase
    .from('couriers')
    .delete()
    .eq('id', courierId);

  if (deleteError) throw new Error(deleteError.message || 'Failed to remove courier record');

  return { id: courierId, deleted: true };
}

// Detailed view for a specific courier (for admin "Approve Users" modal)
export async function getAdminCourierDetail(courierId) {
  if (!supabase) throw new Error('Server not configured');

  const [
    { data: courier, error: courierError },
    { data: vehicles, error: vehicleError },
    { data: documents, error: docsError },
    { data: payoutMethods, error: payoutError },
  ] = await Promise.all([
    supabase
      .from('couriers')
      .select(
        `
        id,
        national_id,
        city,
        date_of_birth,
        drivers_license_number,
        is_verified,
        verification_status,
        rating,
        total_deliveries,
        total_earnings,
        account_balance,
        created_at,
        user_profiles ( full_name, email, phone, profile_photo )
      `,
      )
      .eq('id', courierId)
      .maybeSingle(),
    supabase
      .from('courier_vehicles')
      .select('id, vehicle_type, brand, model, year, color, license_plate, vehicle_photo_url, registration_certificate_url, is_active')
      .eq('courier_id', courierId)
      .order('created_at', { ascending: false }),
    supabase
      .from('courier_documents')
      .select('id, document_type, document_url, status, created_at')
      .eq('courier_id', courierId)
      .order('created_at', { ascending: true }),
    supabase
      .from('courier_payout_methods')
      .select('id, method_type, provider, account_number, account_name, is_default, created_at')
      .eq('courier_id', courierId)
      .order('is_default', { ascending: false }),
  ]);

  if (courierError) throw new Error(courierError.message || 'Failed to load courier');
  if (!courier) throw new Error('Courier not found');
  if (vehicleError) throw new Error(vehicleError.message || 'Failed to load courier vehicles');
  if (docsError) throw new Error(docsError.message || 'Failed to load courier documents');
  if (payoutError) console.warn('Failed to load payout methods:', payoutError.message);

  const signedVehicles = await Promise.all(
    (vehicles || []).map(async (v) => {
      let out = v;
      out = await addSignedUrlToItem(out, 'vehicle_photo_url', 'vehicle_photo_signed_url');
      out = await addSignedUrlToItem(out, 'registration_certificate_url', 'registration_certificate_signed_url');
      return out;
    }),
  );

  const signedDocuments = await Promise.all(
    (documents || []).map(async (d) => addSignedUrlToItem(d, 'document_url', 'document_signed_url')),
  );

  const courierWithSignedProfile = await addSignedUrlToItem(
    { ...courier, profile_photo_url: courier.user_profiles?.profile_photo || null },
    'profile_photo_url',
    'profile_photo_signed_url',
  );

  return {
    courier: {
      ...courier,
      profile_photo_signed_url: courierWithSignedProfile?.profile_photo_signed_url || null,
    },
    vehicles: signedVehicles,
    documents: signedDocuments,
    payoutMethods: payoutMethods || [],
  };
}

// Detailed view for a specific merchant (for admin "Approve Users" modal)
export async function getAdminMerchantDetail(merchantId) {
  if (!supabase) throw new Error('Server not configured');

  const [
    { data: merchant, error: merchantError },
    { data: stores, error: storesError },
    { data: documents, error: docsError },
  ] = await Promise.all([
    supabase
      .from('merchants')
      .select(
        `
        id,
        business_name,
        business_type,
        business_registration_number,
        tax_id,
        is_verified,
        is_active,
        approval_status,
        created_at,
        user_profiles ( full_name, email, phone )
      `,
      )
      .eq('id', merchantId)
      .maybeSingle(),
    supabase
      .from('stores')
      .select('id, store_name, logo, banner_url, phone, email, address_line1, address_line2, city, state_province, postal_code, country, operating_hours, is_open, is_active, rating, created_at')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false }),
    supabase
      .from('merchant_documents')
      .select('id, document_type, document_url, status, created_at')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: true }),
  ]);

  if (merchantError) throw new Error(merchantError.message || 'Failed to load merchant');
  if (!merchant) throw new Error('Merchant not found');
  if (storesError) throw new Error(storesError.message || 'Failed to load stores');
  if (docsError) throw new Error(docsError.message || 'Failed to load merchant documents');

  const signedStores = await Promise.all(
    (stores || []).map(async (s) => {
      let out = s;
      out = await addSignedUrlToItem(out, 'logo', 'logo_signed_url');
      out = await addSignedUrlToItem(out, 'banner_url', 'banner_signed_url');
      return out;
    }),
  );

  const signedDocuments = await Promise.all(
    (documents || []).map(async (d) => addSignedUrlToItem(d, 'document_url', 'document_signed_url')),
  );

  return {
    merchant,
    stores: signedStores,
    documents: signedDocuments,
  };
}


/** Suspend or unsuspend a user by setting is_suspended on their profile row. */
export async function adminSuspendUser(userId, suspend) {
  if (!supabase) throw new Error('Server not configured');
  if (!userId) throw new Error('User id is required');
  const { error } = await supabase
    .from('user_profiles')
    .update({ is_suspended: !!suspend })
    .eq('id', userId);
  if (error) throw new Error(error.message || 'Failed to update user suspension status');
}
