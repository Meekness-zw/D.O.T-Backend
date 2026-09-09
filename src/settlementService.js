/**
 * What the accountant sees, and what they act on.
 *
 * A customer pays one number. That number is several people's money, and the
 * accountant's job is to send each part to the right account. This module
 * turns an order into that breakdown and records the disbursements.
 *
 * The breakdown is DERIVED, never stored. Recomputing from the order's own
 * columns means a rate change cannot silently rewrite what an old order was
 * worth, and the arithmetic can be re-checked against the money that actually
 * moved. The one thing stored is the disbursement itself.
 *
 * Deliberately NOT here: the call to a payment provider. Nothing in this
 * repository talks to Contipay — the payout_disbursements table was created
 * for it, but no code was ever written. `recordDisbursement` writes the ledger
 * and the audit row for a transfer the accountant has made; `sendDisbursement`
 * is the single seam where a provider call belongs when credentials exist.
 * Pretending money moved when it did not would be far worse than saying so.
 */

import { supabaseAdmin } from './supabaseAdminClient.js';
import {
  computeCourierDeliveryPayoutUsd,
  computeSubtotalSplit,
  resolveCourierPayoutDestination,
} from './orderPaymentSplit.js';

const supabase = supabaseAdmin;

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Split one order into every party's share.
 *
 * Returns the customer's total alongside the parts so the caller can assert
 * they reconcile — a breakdown that does not add up to what was charged is a
 * bug worth surfacing, not rounding away.
 */
export function settlementForOrder(order) {
  const subtotal = money(order.subtotal);
  const deliveryFee = money(order.delivery_fee);
  const customerDeliveryFee = money(order.customer_delivery_fee);
  const subsidy = money(order.dot_delivery_subsidy);
  const tax = money(order.tax);
  const tip = money(order.courier_tip);

  const { merchantEarnings, platformCommission } = computeSubtotalSplit(subtotal);
  const courierFeeShare = computeCourierDeliveryPayoutUsd(deliveryFee);
  const deliveryPlatformCut = money(deliveryFee - courierFeeShare);

  const courierTotal = money(courierFeeShare + tip);
  const customerPaid = money(subtotal + customerDeliveryFee + tax + tip);

  // What DOT keeps: the product markup plus its share of the delivery fee,
  // less any promo it funded itself. Can legitimately go negative on a
  // heavily discounted order — that is DOT buying the order, and hiding it
  // behind a floor of zero would misstate the margin.
  const dotNet = money(platformCommission + deliveryPlatformCut - subsidy);

  return {
    order_id: order.id,
    order_number: order.order_number,
    created_at: order.created_at,
    delivered_at: order.actual_delivery_time,
    status: order.status,
    payment_status: order.payment_status,
    payment_method: order.payment_method,

    customer_paid: customerPaid,
    lines: {
      subtotal,
      tax,
      customer_delivery_fee: customerDeliveryFee,
      courier_tip: tip,
    },

    store: {
      merchant_id: order.store?.merchant_id ?? order.merchant_id ?? null,
      store_id: order.store_id,
      store_name: order.store?.store_name ?? null,
      // The merchant's own base price. The 15% markup was added on top for
      // the customer and was never the merchant's money.
      amount_due: merchantEarnings,
      dot_markup: platformCommission,
    },

    courier: {
      courier_id: order.courier_id,
      delivery_fee_share: courierFeeShare,
      tip,
      amount_due: courierTotal,
      dot_delivery_cut: deliveryPlatformCut,
    },

    dot: {
      product_markup: platformCommission,
      delivery_cut: deliveryPlatformCut,
      promo_subsidy: subsidy,
      net: dotNet,
    },
  };
}

/**
 * The parts must add up to what the customer was charged.
 *
 * The promo subsidy is NOT added back here. It is already inside dot.net as a
 * negative — DOT paying part of the delivery fee on the customer's behalf —
 * and the customer was charged that much less. Adding it a second time
 * overstates the distribution by exactly the discount, which is what an
 * earlier version of this function did.
 */
export function reconcile(s) {
  const out = money(s.store.amount_due + s.courier.amount_due + s.dot.net + s.lines.tax);
  return { balanced: Math.abs(out - s.customer_paid) < 0.02, distributed: out, charged: s.customer_paid };
}

/**
 * Orders that are settled money-wise and ready for the accountant to act on.
 *
 * Only paid, delivered orders: money that has not arrived cannot be sent on,
 * and an undelivered order can still be cancelled.
 */
export async function listSettlements({ from, to, storeId, courierId, limit = 500 } = {}) {
  if (!supabase) throw new Error('Server not configured');

  let query = supabase
    .from('orders')
    .select(`id, order_number, created_at, actual_delivery_time, status, payment_status,
             payment_method, subtotal, delivery_fee, customer_delivery_fee, dot_delivery_subsidy,
             tax, courier_tip, total_amount, store_id, courier_id,
             stores!inner ( id, store_name, merchant_id )`)
    .eq('payment_status', 'paid')
    .eq('status', 'delivered')
    .order('actual_delivery_time', { ascending: false })
    .limit(Math.min(Number(limit) || 500, 2000));

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  if (storeId) query = query.eq('store_id', storeId);
  if (courierId) query = query.eq('courier_id', courierId);

  const { data, error } = await query;
  if (error) throw new Error(error.message || 'Failed to load settlements');

  const orders = (data || []).map((o) => ({ ...o, store: o.stores }));
  const orderIds = orders.map((o) => o.id);

  // Which of these has already been paid out, and to whom.
  const paidKeys = new Set();
  if (orderIds.length) {
    const { data: paid } = await supabase
      .from('payout_disbursements')
      .select('order_id, recipient_type, status')
      .in('order_id', orderIds)
      .eq('status', 'completed');
    for (const p of paid || []) paidKeys.add(`${p.order_id}:${p.recipient_type}`);
  }

  return orders.map((o) => {
    const s = settlementForOrder(o);
    s.paid = {
      merchant: paidKeys.has(`${o.id}:merchant`),
      courier: paidKeys.has(`${o.id}:courier`),
    };
    s.reconciliation = reconcile(s);
    return s;
  });
}

/** One order, with the destination accounts resolved. */
export async function settlementDetail(orderId) {
  if (!supabase) throw new Error('Server not configured');
  const { data: order, error } = await supabase
    .from('orders')
    .select(`id, order_number, created_at, actual_delivery_time, status, payment_status,
             payment_method, subtotal, delivery_fee, customer_delivery_fee, dot_delivery_subsidy,
             tax, courier_tip, total_amount, store_id, courier_id,
             stores ( id, store_name, merchant_id, address_line1, city )`)
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load order');
  if (!order) {
    const e = new Error('Order not found'); e.status = 404; throw e;
  }

  const s = settlementForOrder({ ...order, store: order.stores });
  s.reconciliation = reconcile(s);

  const { data: items } = await supabase
    .from('order_items')
    .select('product_name, product_price, quantity')
    .eq('order_id', orderId);
  s.items = items || [];

  const [courierDest, merchantMethod, existing] = await Promise.all([
    order.courier_id ? resolveCourierPayoutDestination(order.courier_id) : Promise.resolve(null),
    order.stores?.merchant_id
      ? supabase.from('merchant_payout_methods')
          .select('id, method_type, provider, provider_code, account_number, account_name, is_verified')
          .eq('merchant_id', order.stores.merchant_id).eq('is_default', true).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('payout_disbursements')
      .select('id, recipient_type, amount, status, reference, company_id, created_at, completed_at, error_message')
      .eq('order_id', orderId),
  ]);

  s.destinations = { courier: courierDest, merchant: merchantMethod?.data || null };
  s.disbursements = existing?.data || [];
  return s;
}

/**
 * Record that the accountant has paid one party for one order.
 *
 * Idempotency is the database's job, not this function's: a partial unique
 * index on (order_id, recipient_user_id, recipient_type) WHERE status =
 * 'completed' means a duplicate is rejected by Postgres even if two
 * accountants press the button at the same instant. A check-then-insert here
 * would still have a gap between the two.
 */
export async function recordDisbursement({ orderId, recipientType, actor, note }) {
  if (!supabase) throw new Error('Server not configured');
  const fail = (status, message, details) => {
    const e = new Error(message); e.status = status; e.details = details; throw e;
  };
  if (!['courier', 'merchant'].includes(recipientType)) fail(400, 'Invalid recipient');

  const s = await settlementDetail(orderId);

  if (recipientType === 'courier') {
    if (!s.courier.courier_id) fail(400, 'No courier on this order');
    if (s.courier.amount_due <= 0) fail(400, 'Nothing owed to the courier');
  } else if (!s.store.merchant_id) {
    fail(400, 'No merchant on this order');
  } else if (s.store.amount_due <= 0) {
    fail(400, 'Nothing owed to the store');
  }

  const dest = recipientType === 'courier' ? s.destinations.courier : s.destinations.merchant;
  if (recipientType === 'courier') {
    if (!dest || dest.kind === 'blocked') {
      fail(409, 'No payout destination', {
        no_payout_method: 'This courier has no default payout method on file.',
        company_inactive: 'This courier rides for a company whose payouts are switched off.',
        company_has_no_payout_method: 'This courier\'s company has no account on file.',
      }[dest?.reason] || 'Nowhere to send this payment.');
    }
  } else if (!dest?.account_number) {
    fail(409, 'No payout destination', 'This store has no default payout method on file.');
  }

  const amount = recipientType === 'courier' ? s.courier.amount_due : s.store.amount_due;
  const recipientUserId = recipientType === 'courier' ? s.courier.courier_id : s.store.merchant_id;
  const short = String(orderId).slice(0, 8);

  const row = {
    order_id: orderId,
    recipient_user_id: recipientUserId,
    recipient_type: recipientType,
    amount,
    currency: 'USD',
    reference: `DOT-PO-${short}-${recipientType}`,
    account_number: recipientType === 'courier' ? dest.accountNumber : dest.account_number,
    account_name: recipientType === 'courier' ? dest.accountName : dest.account_name,
    provider: recipientType === 'courier' ? dest.provider : dest.provider,
    provider_code: recipientType === 'courier' ? dest.providerCode : dest.provider_code,
    payout_method_id: recipientType === 'courier' ? dest.payoutMethodId ?? null : dest.id ?? null,
    // Set only when the money went to an umbrella company. recipient_user_id
    // still names the courier who earned it, so per-rider history survives.
    company_id: recipientType === 'courier' && dest.kind === 'company' ? dest.companyId : null,
    status: 'completed',
    completed_at: new Date().toISOString(),
    raw_request: { recorded_by: actor || 'dashboard', note: note || null, breakdown: s[recipientType === 'courier' ? 'courier' : 'store'] },
  };

  const { data, error } = await supabase
    .from('payout_disbursements')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (/duplicate key|unique/i.test(error.message || '')) {
      fail(409, 'Already paid', 'This party has already been paid for this order.');
    }
    throw new Error(error.message || 'Failed to record disbursement');
  }
  return { disbursement: data, settlement: s };
}

/**
 * The seam a real provider call goes behind.
 *
 * Left unimplemented on purpose: there is no Contipay client in this repo and
 * no credentials to make one work. Wiring a stub that returned success would
 * mark money as sent that never left the account.
 */
export async function sendDisbursement() {
  const e = new Error('Automated transfers are not connected');
  e.status = 501;
  e.details = 'No payment provider is configured. Record the transfer here after making it, and it will be tracked and printable.';
  throw e;
}
