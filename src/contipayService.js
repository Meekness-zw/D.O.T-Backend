import axios from 'axios';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';
import { notifyCustomerPaymentReceived } from './orderNotifications.js';

const supabase = supabaseAdmin;
const CONTIPAY_BASE_URL = 'https://api.contipay.co.zw/v1';

export function getContipayConfig() {
  const apiKey = process.env.CONTIPAY_API_KEY;
  const apiSecret = process.env.CONTIPAY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('CONTIPAY_API_KEY and CONTIPAY_API_SECRET must be set in backend/.env');
  }
  return { apiKey, apiSecret };
}

function mapContipayStatus(status) {
  const s = (status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCESSFUL') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
  return 'pending';
}

/**
 * Initiate a ContiPay payment for an order.
 * Returns { paymentUrl, payment }
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
}) {
  if (!userId) throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!phone) throw new Error('customer phone is required');
  if (!reference) throw new Error('reference is required');

  const { apiKey, apiSecret } = getContipayConfig();

  const response = await axios.post(
    `${CONTIPAY_BASE_URL}/payments/initiate`,
    {
      amount,
      currency: 'USD',
      customer_phone: phone,
      customer_email: email || '',
      reference,
      callback_url: callbackUrl,
      return_url: returnUrl || callbackUrl,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'x-api-secret': apiSecret,
      },
    },
  );

  const paymentUrl = response.data?.payment_url;
  if (!paymentUrl) {
    console.error('[ContiPay] Unexpected response:', response.status, JSON.stringify(response.data));
    throw new Error(`ContiPay did not return a payment URL (status ${response.status})`);
  }

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .insert({
      order_id: orderId || null,
      customer_id: userId,
      amount,
      currency: 'USD',
      payment_method: 'contipay',
      payment_provider: 'ContiPay',
      transaction_id: reference,
      status: 'pending',
      metadata: { reference, contipay_response: response.data },
    })
    .select('*')
    .single();

  if (paymentError) {
    console.error('[ContiPay] Failed to insert payment record:', paymentError);
    throw new Error(paymentError.message || 'Failed to save payment');
  }

  return { paymentUrl, payment };
}

/**
 * Handle ContiPay callback (server-to-server POST from ContiPay).
 * Expected body: { status: 'SUCCESS'|'FAILED', reference, ... }
 */
export async function handleContipayCallback(body) {
  const { status, reference } = body || {};
  if (!reference) throw new Error('Missing reference in ContiPay callback');

  const paymentStatus = mapContipayStatus(status);

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
    console.error('[ContiPay] Failed to load order for callback:', orderLoadError);
    return;
  }

  if (order.payment_status === 'paid') return; // already processed

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
}
