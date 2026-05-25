/**
 * On delivery confirmation, fire automatic Contipay disbursements for the
 * merchant's order earnings and the courier's delivery fee. Best-effort:
 * any failure just leaves the earnings in the wallet for manual cashout
 * later, and is logged but does not break the calling request.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { disburseToWallet } from './contipayDisburseService.js';

const supabase = supabaseAdmin;

async function loadDefaultPayoutMethod(userId, kind) {
  const table = kind === 'merchant' ? 'merchant_payout_methods' : 'courier_payout_methods';
  const fk    = kind === 'merchant' ? 'merchant_id'             : 'courier_id';

  const { data, error } = await supabase
    .from(table)
    .select('id, provider, provider_code, account_number, account_name')
    .eq(fk, userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[payout] failed to load ${kind} payout method:`, error);
    return null;
  }
  return data || null;
}

async function findEarningsAmount({ userId, userType, referenceId }) {
  const { data } = await supabase
    .from('wallet_transactions')
    .select('amount')
    .eq('user_id', userId)
    .eq('user_type', userType)
    .eq('transaction_type', 'earnings')
    .eq('reference_id', referenceId)
    .maybeSingle();
  return data ? Number(data.amount) : 0;
}

export async function triggerOrderPayoutsOnDelivery({ orderId }) {
  if (!supabase || !orderId) return { skipped: true };

  const { data: order } = await supabase
    .from('orders')
    .select('id, order_number, store_id, courier_id')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return { skipped: true, reason: 'order_not_found' };

  const results = { merchant: null, courier: null };

  // ─── Merchant ─────────────────────────────────────────────────────────────
  try {
    if (order.store_id) {
      const { data: store } = await supabase
        .from('stores')
        .select('merchant_id')
        .eq('id', order.store_id)
        .maybeSingle();
      const merchantId = store?.merchant_id;
      if (merchantId) {
        const { data: payment } = await supabase
          .from('payments')
          .select('id')
          .eq('order_id', orderId)
          .eq('payment_method', 'contipay')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const amount = payment
          ? await findEarningsAmount({ userId: merchantId, userType: 'merchant', referenceId: payment.id })
          : 0;
        const method = await loadDefaultPayoutMethod(merchantId, 'merchant');
        if (amount > 0 && method?.account_number) {
          results.merchant = await disburseToWallet({
            recipientUserId: merchantId,
            recipientType:   'merchant',
            orderId,
            payoutMethodId:  method.id,
            amount,
            accountNumber:   method.account_number,
            providerCode:    method.provider_code,
            providerName:    method.provider,
            accountName:     method.account_name,
            description:     `DOT order ${order.order_number || orderId} — merchant earnings`,
          });
        } else {
          results.merchant = { skipped: true, reason: !method ? 'no_payout_method' : amount > 0 ? 'unknown' : 'no_earnings' };
        }
      }
    }
  } catch (err) {
    console.error('[payout] merchant disburse failed:', err?.message || err);
    results.merchant = { ok: false, error: err?.message || 'unknown_error' };
  }

  // ─── Courier ──────────────────────────────────────────────────────────────
  try {
    if (order.courier_id) {
      const amount = await findEarningsAmount({
        userId: order.courier_id,
        userType: 'courier',
        referenceId: orderId,
      });
      const method = await loadDefaultPayoutMethod(order.courier_id, 'courier');
      if (amount > 0 && method?.account_number) {
        results.courier = await disburseToWallet({
          recipientUserId: order.courier_id,
          recipientType:   'courier',
          orderId,
          payoutMethodId:  method.id,
          amount,
          accountNumber:   method.account_number,
          providerCode:    method.provider_code,
          providerName:    method.provider,
          accountName:     method.account_name,
          description:     `DOT delivery ${order.order_number || orderId} — courier payout`,
        });
      } else {
        results.courier = { skipped: true, reason: !method ? 'no_payout_method' : amount > 0 ? 'unknown' : 'no_earnings' };
      }
    }
  } catch (err) {
    console.error('[payout] courier disburse failed:', err?.message || err);
    results.courier = { ok: false, error: err?.message || 'unknown_error' };
  }

  return results;
}
