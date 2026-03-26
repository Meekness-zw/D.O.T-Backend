/**
 * Internal split when an order is paid online (Pesepay).
 * Industry benchmark: marketplace commission commonly ~15–30% of food subtotal (DoorDash/Uber Eats tiers).
 * Default 20% — override with PLATFORM_COMMISSION_RATE (e.g. 0.15).
 *
 * Delivery fee: credited to courier on POST /courier/orders/:id/complete (see recordCourierDeliveryEarnings).
 */

import { supabaseAdmin } from './supabaseAdminClient.js';

const supabase = supabaseAdmin;

export function getPlatformCommissionRate() {
  const raw = process.env.PLATFORM_COMMISSION_RATE;
  const n = raw != null && raw !== '' ? parseFloat(String(raw), 10) : 0.2;
  if (!Number.isFinite(n) || n < 0 || n > 0.5) return 0.2;
  return n;
}

export function computeSubtotalSplit(subtotal) {
  const sub = Number(subtotal || 0);
  const rate = getPlatformCommissionRate();
  const platformCommission = Math.round(sub * rate * 100) / 100;
  const merchantEarnings = Math.round((sub - platformCommission) * 100) / 100;
  return { platformCommission, merchantEarnings };
}

/**
 * Record merchant earnings in wallet ledger (idempotent per payment id).
 */
export async function recordMerchantEarningsForOrderPayment({
  merchantUserId,
  paymentId,
  amount,
  orderNumber,
}) {
  if (!supabase || !merchantUserId || !paymentId || !amount || amount <= 0) return null;

  const { data: existing } = await supabase
    .from('wallet_transactions')
    .select('id')
    .eq('user_id', merchantUserId)
    .eq('reference_id', paymentId)
    .eq('transaction_type', 'earnings')
    .maybeSingle();

  if (existing?.id) {
    return { skipped: true, reason: 'already_recorded' };
  }

  const { data: lastTx } = await supabase
    .from('wallet_transactions')
    .select('balance_after')
    .eq('user_id', merchantUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevBalance = lastTx?.balance_after || 0;
  const newBalance = Math.round((prevBalance + amount) * 100) / 100;

  const { data, error } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: merchantUserId,
      user_type: 'merchant',
      transaction_type: 'earnings',
      amount,
      balance_after: newBalance,
      description: `Order ${orderNumber || ''} (after platform fee)`,
      reference_id: paymentId,
      status: 'completed',
    })
    .select('*')
    .single();

  if (error) {
    console.error('[orderPaymentSplit] merchant earnings insert error:', error);
    return null;
  }

  return data;
}

/**
 * Credit courier when an order is marked delivered. Amount = order delivery_fee (customer-paid delivery).
 * Idempotent per order (reference_id = order id). Updates wallet_transactions + couriers.account_balance.
 */
export async function recordCourierDeliveryEarnings({ courierId, orderId, amount, orderNumber }) {
  if (!supabase || !courierId || !orderId || amount == null) return null;
  const credit = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(credit) || credit <= 0) {
    console.warn('[orderPaymentSplit] courier delivery earnings skipped: invalid amount', amount);
    return null;
  }

  const { data: existing } = await supabase
    .from('wallet_transactions')
    .select('id')
    .eq('user_id', courierId)
    .eq('reference_id', orderId)
    .eq('transaction_type', 'earnings')
    .maybeSingle();

  if (existing?.id) {
    return { skipped: true, reason: 'already_recorded' };
  }

  const { data: lastTx } = await supabase
    .from('wallet_transactions')
    .select('balance_after')
    .eq('user_id', courierId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevBalance = Number(lastTx?.balance_after) || 0;
  const newBalance = Math.round((prevBalance + credit) * 100) / 100;

  const { data: tx, error: txError } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: courierId,
      user_type: 'courier',
      transaction_type: 'earnings',
      amount: credit,
      balance_after: newBalance,
      description: `Delivery completed — order ${orderNumber || String(orderId).slice(0, 8)}`,
      reference_id: orderId,
      status: 'completed',
    })
    .select('*')
    .single();

  if (txError) {
    console.error('[orderPaymentSplit] courier earnings insert error:', txError);
    return null;
  }

  const { data: courierRow } = await supabase
    .from('couriers')
    .select('total_earnings, total_deliveries')
    .eq('id', courierId)
    .maybeSingle();

  const nextTotal = Math.round((Number(courierRow?.total_earnings || 0) + credit) * 100) / 100;
  const nextDeliveries = (courierRow?.total_deliveries || 0) + 1;

  const { error: courierUpdErr } = await supabase
    .from('couriers')
    .update({
      account_balance: newBalance,
      total_earnings: nextTotal,
      total_deliveries: nextDeliveries,
    })
    .eq('id', courierId);

  if (courierUpdErr) {
    console.error('[orderPaymentSplit] courier row update error:', courierUpdErr);
  }

  return { walletTransaction: tx, balance_after: newBalance, amount: credit };
}
