import { createRequire } from 'node:module';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';
import { notifyCustomerPaymentReceived } from './orderNotifications.js';

// The contipay npm package is CommonJS — use createRequire to load it in an ESM project
const require = createRequire(import.meta.url);
const contipay = require('contipay');

const supabase = supabaseAdmin;

export function getContipayConfig() {
  const apiKey = process.env.CONTIPAY_API_KEY || process.env.CONTIPAY_TOKEN;

  if (!apiKey) {
    throw new Error('CONTIPAY_API_KEY must be set in backend/.env');
  }
  return { apiKey };
}

/**
 * Resolve which ContiPay payment method to use.
 * Falls back to the CONTIPAY_DEFAULT_METHOD env var, then 'ecocash'.
 */
function resolvePaymentMethod(requested) {
  const allowed = ['card', 'ecocash', 'onemoney', 'zipit'];
  if (requested && allowed.includes(requested)) return requested;
  const envDefault = process.env.CONTIPAY_DEFAULT_METHOD;
  if (envDefault && allowed.includes(envDefault)) return envDefault;
  return 'ecocash';
}

function mapContipayStatus(status) {
  const s = (status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCESSFUL' || s === 'PAID' || s === 'COMPLETE' || s === 'COMPLETED') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED' || s === 'CANCELED' || s === 'DECLINED') return 'failed';
  return 'pending';
}

/**
 * Initiate a ContiPay payment for an order using the official contipay SDK.
 * Returns { paymentUrl, reference }
 */
export async function initiateContipayPayment({
  userId,
  orderId,
  amount,
  phone,
  email,
  reference,
  callbackUrl,
  returnUrl,
  method,
}) {
  if (!userId) throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!reference) throw new Error('reference is required');

  const { apiKey } = getContipayConfig();

  // Configure the SDK with the API key if it exposes a configure / setApiKey method
  if (typeof contipay.configure === 'function') {
    contipay.configure({ apiKey });
  } else if (typeof contipay.setApiKey === 'function') {
    contipay.setApiKey(apiKey);
  } else if (typeof contipay.init === 'function') {
    contipay.init({ apiKey });
  }
  // If none of the above — the SDK may read CONTIPAY_API_KEY from process.env automatically

  const paymentMethod = resolvePaymentMethod(method);

  console.log('[ContiPay] Creating payment:', { orderId, amount, reference, method: paymentMethod });

  let payment;
  try {
    payment = await contipay.createPayment({
      amount: Number(amount),
      currency: 'USD',
      method: paymentMethod,
      reference,
      callback: callbackUrl,
      ...(returnUrl ? { returnUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    });
  } catch (sdkErr) {
    console.error('[ContiPay] SDK error:', sdkErr?.message || sdkErr);
    throw new Error(`ContiPay payment creation failed: ${sdkErr?.message || 'Unknown error'}`);
  }

  const paymentUrl = payment?.checkoutUrl || payment?.paymentUrl || payment?.checkout_url || payment?.url;
  if (!paymentUrl) {
    console.error('[ContiPay] No checkout URL in SDK response:', payment);
    throw new Error('ContiPay did not return a checkout URL');
  }

  console.log('[ContiPay] Payment created. Checkout URL:', paymentUrl);

  // Record the payment in our database
  const { data: paymentRecord, error: paymentError } = await supabase
    .from('payments')
    .insert({
      order_id: orderId || null,
      customer_id: userId,
      amount: Number(amount),
      currency: 'USD',
      payment_method: 'contipay',
      payment_provider: 'ContiPay',
      transaction_id: reference,
      status: 'pending',
      metadata: {
        reference,
        method: paymentMethod,
        contipay_payment_id: payment?.id || payment?.paymentId || null,
      },
    })
    .select('*')
    .single();

  if (paymentError) {
    console.error('[ContiPay] Failed to insert payment record:', paymentError);
    throw new Error(paymentError.message || 'Failed to save payment record');
  }

  return { paymentUrl, payment: paymentRecord };
}

/**
 * Handle ContiPay server-to-server callback.
 * ContiPay POSTs { status, reference, ... } to our callback URL.
 */
export async function handleContipayCallback(body) {
  const { status, reference } = body || {};
  if (!reference) throw new Error('Missing reference in ContiPay callback');

  const paymentStatus = mapContipayStatus(status);
  console.log('[ContiPay] Callback received:', { reference, status, paymentStatus });

  // Merge existing metadata with callback payload
  const { data: prevPay } = await supabase
    .from('payments')
    .select('metadata')
    .eq('transaction_id', reference)
    .maybeSingle();

  const mergedMeta = {
    ...(prevPay?.metadata && typeof prevPay.metadata === 'object' ? prevPay.metadata : {}),
    ...(body && typeof body === 'object' ? body : {}),
  };

  const { data: payment, error: updateError } = await supabase
    .from('payments')
    .update({ status: paymentStatus, metadata: mergedMeta })
    .eq('transaction_id', reference)
    .select('*')
    .maybeSingle();

  if (updateError) {
    console.error('[ContiPay] Failed to update payment from callback:', updateError);
    throw new Error(updateError.message || 'Failed to update payment');
  }

  if (!payment) {
    console.warn('[ContiPay] Callback for unknown reference:', reference);
    return { payment: null };
  }

  if (payment.order_id) {
    if (paymentStatus === 'completed') {
      await finalizeOrderPayment(payment);
    } else if (paymentStatus === 'failed') {
      await supabase
        .from('orders')
        .update({ payment_status: 'failed' })
        .eq('id', payment.order_id)
        .eq('payment_status', 'pending');
    }
  }

  return { payment };
}

async function finalizeOrderPayment(payment) {
  const { data: order, error: orderLoadError } = await supabase
    .from('orders')
    .select('id, order_number, customer_id, store_id, subtotal, payment_status')
    .eq('id', payment.order_id)
    .maybeSingle();

  if (orderLoadError || !order) {
    console.error('[ContiPay] Failed to load order for finalization:', orderLoadError);
    return;
  }

  if (order.payment_status === 'paid') return; // already processed — idempotent

  const { platformCommission, merchantEarnings } = computeSubtotalSplit(order.subtotal);

  const { data: store } = await supabase
    .from('stores')
    .select('merchant_id, store_name')
    .eq('id', order.store_id)
    .maybeSingle();

  const { data: updatedOrder, error: orderUpdateError } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      status: 'pending',
      platform_commission_amount: platformCommission,
      merchant_earnings_amount: merchantEarnings,
    })
    .eq('id', order.id)
    .select('*')
    .single();

  if (orderUpdateError) {
    console.error('[ContiPay] Failed to mark order paid:', orderUpdateError);
    return;
  }

  await notifyCustomerPaymentReceived(supabase, {
    customerId: order.customer_id,
    orderId: updatedOrder.id,
    orderNumber: updatedOrder.order_number,
    storeName: store?.store_name,
  });

  if (store?.merchant_id && merchantEarnings > 0) {
    await recordMerchantEarningsForOrderPayment({
      merchantUserId: store.merchant_id,
      paymentId: payment.id,
      amount: merchantEarnings,
      orderNumber: order.order_number,
    });
  }

  console.log('[ContiPay] Order finalized as paid:', order.id);
}
