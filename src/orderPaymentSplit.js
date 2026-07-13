/**
 * Platform money model:
 *  - Every merchant price is automatically marked up 15% for customers
 *    (PLATFORM_MARKUP_RATE). The markup stays in DOT's account on every
 *    transaction; the merchant is credited their own base price.
 *  - A weekly 5% commission (WEEKLY_COMMISSION_RATE) is deducted from
 *    merchant balances at distribution time (see /admin/payout-details).
 *
 * Courier delivery payout: credited when the customer confirms delivery.
 * The courier keeps the delivery fee minus DOT's 20% cut
 * (DELIVERY_PLATFORM_CUT_RATE) — the base $4.99 fee pays the courier
 * exactly $4.00, DOT $0.99.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';

const supabase = supabaseAdmin;

/** Markup added on top of every merchant price for customers (default 15%). */
export function getPlatformMarkupRate() {
  const raw = process.env.PLATFORM_MARKUP_RATE;
  const n = raw != null && raw !== '' ? parseFloat(String(raw), 10) : 0.15;
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.15;
  return n;
}

/** Customer-facing price for a merchant base price. */
export function applyPlatformMarkup(basePrice) {
  const base = Number(basePrice) || 0;
  return Math.round(base * (1 + getPlatformMarkupRate()) * 100) / 100;
}

/** Weekly commission deducted from merchant payouts (default 5%). */
export function getWeeklyCommissionRate() {
  const raw = process.env.WEEKLY_COMMISSION_RATE;
  const n = raw != null && raw !== '' ? parseFloat(String(raw), 10) : 0.05;
  if (!Number.isFinite(n) || n < 0 || n > 0.5) return 0.05;
  return n;
}

/** Platform's cut of every delivery fee (default 20% — drivers keep 80%). */
export function getDeliveryPlatformCutRate() {
  const raw = process.env.DELIVERY_PLATFORM_CUT_RATE;
  const n = raw != null && raw !== '' ? parseFloat(String(raw), 10) : 0.2;
  if (!Number.isFinite(n) || n < 0 || n > 0.5) return 0.2;
  return n;
}

/** Customer-facing delivery platform fee labeled OTD (“On-Time Delivery”). */
export function getOtdPlatformServiceChargeUsd() {
  const raw = process.env.OTD_PLATFORM_SERVICE_CHARGE_USD;
  const n = raw != null && raw !== '' ? parseFloat(String(raw), 10) : 0.99;
  if (!Number.isFinite(n) || n < 0) return 0.99;
  return Math.round(n * 100) / 100;
}

/**
 * Courier wallet credit for completing a delivery: the fee minus DOT's
 * 20% cut (floored to the cent so the base $4.99 splits exactly
 * $0.99 to DOT and $4.00 to the courier).
 */
export function computeCourierDeliveryPayoutUsd(deliveryFee) {
  const total = Number(deliveryFee) || 0;
  if (total <= 0) return 0;
  const platformCut = Math.floor(total * getDeliveryPlatformCutRate() * 100) / 100;
  return Math.round((total - platformCut) * 100) / 100;
}

/**
 * The customer-paid subtotal already contains the platform markup
 * (menu prices are served marked up). The merchant is credited their
 * base price; the markup remains with DOT.
 */
export function computeSubtotalSplit(subtotal) {
  const sub = Number(subtotal || 0);
  const markup = getPlatformMarkupRate();
  const merchantEarnings = Math.round((sub / (1 + markup)) * 100) / 100;
  const platformCommission = Math.round((sub - merchantEarnings) * 100) / 100;
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
 * Credit courier when an order is marked delivered — amount is computed (see computeCourierDeliveryPayoutUsd).
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
      description: `Delivery payout — order ${orderNumber || String(orderId).slice(0, 8)}`,
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
