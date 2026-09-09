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
 *
 * Tips are outside all of that. The courier site promises "100% of your
 * tips", so a tip never enters computeCourierDeliveryPayoutUsd and no cut
 * is taken from it. It is credited as its own ledger line (type 'tip') so
 * the promise stays auditable and so an accountant disbursing money can see
 * fee and tip as two numbers rather than one blended total.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import { getWalletBalance } from './walletLedger.js';

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

  const prevBalance = await getWalletBalance(merchantUserId, 'merchant');
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

  const prevBalance = await getWalletBalance(courierId, 'courier');
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


/**
 * Credit a customer's tip to the courier, in full.
 *
 * Separate from recordCourierDeliveryEarnings on purpose. Merging the two
 * would make the 100%-of-tips promise unverifiable after the fact: once the
 * amounts are summed into one row, nothing distinguishes a $4.00 fee plus a
 * $2.00 tip from a $6.00 fee, and the platform cut on those differs.
 *
 * Idempotent per order, keyed the same way as the earnings row — the two
 * differ by transaction_type, so one can exist without the other.
 */
export async function recordCourierTip({ courierId, orderId, amount, orderNumber }) {
  if (!supabase || !courierId || !orderId) return null;
  const tip = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(tip) || tip <= 0) return null;

  const { data: existing } = await supabase
    .from('wallet_transactions')
    .select('id')
    .eq('user_id', courierId)
    .eq('reference_id', orderId)
    .eq('transaction_type', 'tip')
    .maybeSingle();
  if (existing?.id) return { skipped: true, reason: 'already_recorded' };

  const prevBalance = await getWalletBalance(courierId, 'courier');
  const newBalance = Math.round((prevBalance + tip) * 100) / 100;

  const { data: tx, error } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: courierId,
      user_type: 'courier',
      transaction_type: 'tip',
      amount: tip,
      balance_after: newBalance,
      description: `Customer tip — order ${orderNumber || String(orderId).slice(0, 8)}`,
      reference_id: orderId,
      status: 'completed',
    })
    .select('*')
    .single();

  if (error) {
    // A failed tip must not fail the delivery. It is recoverable from the
    // order row, which still holds courier_tip.
    console.error('[orderPaymentSplit] courier tip insert error:', error);
    return null;
  }

  // total_earnings tracks what the courier actually received, so the tip
  // belongs in it. total_deliveries is NOT incremented — the delivery was
  // already counted by recordCourierDeliveryEarnings, and counting it twice
  // would inflate every per-delivery average on the courier's dashboard.
  const { data: courierRow } = await supabase
    .from('couriers')
    .select('total_earnings')
    .eq('id', courierId)
    .maybeSingle();

  const { error: updErr } = await supabase
    .from('couriers')
    .update({
      account_balance: newBalance,
      total_earnings: Math.round((Number(courierRow?.total_earnings || 0) + tip) * 100) / 100,
    })
    .eq('id', courierId);
  if (updErr) console.error('[orderPaymentSplit] courier tip row update error:', updErr);

  return { walletTransaction: tx, balance_after: newBalance, amount: tip };
}

/**
 * Where a courier's money should actually be sent.
 *
 * A courier riding for an umbrella company is paid through the company: the
 * company settles with its own riders off-platform. The delivery record still
 * names the individual, so per-rider history and tracking are unaffected —
 * only the destination account changes.
 *
 * Returns null when there is nowhere to send money, which the caller must
 * treat as "cannot pay yet" rather than "pay the courier directly": silently
 * falling back to the individual would pay the wrong party.
 */
export async function resolveCourierPayoutDestination(courierId) {
  if (!supabase || !courierId) return null;

  const { data: courier } = await supabase
    .from('couriers')
    .select('id, company_id')
    .eq('id', courierId)
    .maybeSingle();

  if (courier?.company_id) {
    const { data: company } = await supabase
      .from('courier_companies')
      .select('id, name, is_active, payout_method_type, payout_provider, payout_provider_code, payout_account_number, payout_account_name')
      .eq('id', courier.company_id)
      .maybeSingle();

    // An inactive company is a deliberate stop on payments to it. Falling
    // through to the courier's own account here would route around that.
    if (company && company.is_active === false) {
      return { kind: 'blocked', reason: 'company_inactive', company };
    }
    if (company?.payout_account_number) {
      return {
        kind: 'company',
        companyId: company.id,
        companyName: company.name,
        methodType: company.payout_method_type,
        provider: company.payout_provider,
        providerCode: company.payout_provider_code,
        accountNumber: company.payout_account_number,
        accountName: company.payout_account_name || company.name,
      };
    }
    return { kind: 'blocked', reason: 'company_has_no_payout_method', company };
  }

  const { data: method } = await supabase
    .from('courier_payout_methods')
    .select('id, method_type, provider, provider_code, account_number, account_name')
    .eq('courier_id', courierId)
    .eq('is_default', true)
    .maybeSingle();

  if (!method?.account_number) return { kind: 'blocked', reason: 'no_payout_method' };

  return {
    kind: 'courier',
    payoutMethodId: method.id,
    methodType: method.method_type,
    provider: method.provider,
    providerCode: method.provider_code,
    accountNumber: method.account_number,
    accountName: method.account_name,
  };
}
