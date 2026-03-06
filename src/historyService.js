/**
 * Order history, payments, and wallet transactions for the current user.
 * Uses supabaseAdmin; all queries are scoped by userId and role.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { getProfile } from './userService.js';

const supabase = supabaseAdmin;

/**
 * Get orders for the current user based on their role.
 * Customer: orders where customer_id = userId
 * Merchant: orders for stores belonging to this merchant
 * Courier: orders where courier_id = userId
 */
export async function getOrdersForUser(userId, options = {}) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  if (!profile?.role) return { orders: [], role: null };

  const { limit = 50, offset = 0, status } = options;
  let query;

  if (profile.role === 'customer') {
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
      .eq('customer_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
  } else if (profile.role === 'merchant') {
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
        created_at,
        updated_at,
        store_id,
        stores ( store_name ),
        order_items (
          product_name,
          quantity
        )
      `)
      .in('store_id', ids)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
  } else if (profile.role === 'courier') {
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
    return { orders: [], role: profile.role };
  }

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(error.message || 'Failed to fetch orders');
  return { orders: data || [], role: profile.role };
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
 * Get full "me" payload: profile + role-specific row (customer, merchant, or courier)
 * so the app has all user fields in one place.
 */
export async function getFullUserMe(userId) {
  if (!userId || !supabase) throw new Error('userId required and server must be configured');

  const profile = await getProfile(userId);
  if (!profile) return null;

  const result = { profile };

  if (profile.role === 'customer') {
    const { data } = await supabase.from('customers').select('*').eq('id', userId).single();
    result.customer = data || null;
  } else if (profile.role === 'merchant') {
    const { data: merchant } = await supabase
      .from('merchants')
      .select('*')
      .eq('id', userId)
      .single();
    result.merchant = merchant || null;

    const { data: store } = await supabase
      .from('stores')
      .select('id, store_name, logo, city, address_line1')
      .eq('merchant_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    result.store = store || null;
  } else if (profile.role === 'courier') {
    const { data } = await supabase.from('couriers').select('*').eq('id', userId).single();
    result.courier = data || null;
  }

  return result;
}
