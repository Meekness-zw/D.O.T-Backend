/**
 * Internal split when an order is paid online (Pesepay).
 * Industry benchmark: marketplace commission commonly ~15–30% of food subtotal (DoorDash/Uber Eats tiers).
 * Default 20% — override with PLATFORM_COMMISSION_RATE (e.g. 0.15).
 *
 * Delivery fee: attributed to courier when a delivery-complete endpoint exists; not credited at payment time.
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
