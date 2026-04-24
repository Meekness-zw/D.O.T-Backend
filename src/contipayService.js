import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Contipay = require('contipay-js/src/contipay.js');
const RedirectMethod = require('contipay-js/src/helpers/redirect_method.js');

import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';
import { notifyCustomerPaymentReceived } from './orderNotifications.js';

const supabase = supabaseAdmin;

// ContiPay API URLs (from official Postman collection)
const CONTIPAY_UAT_URL  = 'https://api-uat.contipay.net';    // sandbox/test
const CONTIPAY_LIVE_URL = 'https://api-v2.contipay.co.zw';   // production

export function getContipayConfig() {
  const isProduction = process.env.NODE_ENV === 'production';

  // Support separate test/live key pairs (official ContiPay pattern).
  // Falls back to the shared CONTIPAY_AUTH_KEY / CONTIPAY_AUTH_SECRET if the
  // environment-specific ones are not set.
  // Accept all naming conventions in order of preference so existing Render
  // vars (CONTIPAY_TOKEN / CONTIPAY_SECRET) keep working without changes.
  const token = isProduction
    ? (process.env.CONTIPAY_LIVE_AUTH_KEY    || process.env.CONTIPAY_AUTH_KEY    || process.env.CONTIPAY_API_KEY || process.env.CONTIPAY_TOKEN)
    : (process.env.CONTIPAY_TEST_AUTH_KEY    || process.env.CONTIPAY_AUTH_KEY    || process.env.CONTIPAY_API_KEY || process.env.CONTIPAY_TOKEN);

  const secret = isProduction
    ? (process.env.CONTIPAY_LIVE_AUTH_SECRET || process.env.CONTIPAY_AUTH_SECRET || process.env.CONTIPAY_API_SECRET || process.env.CONTIPAY_SECRET)
    : (process.env.CONTIPAY_TEST_AUTH_SECRET || process.env.CONTIPAY_AUTH_SECRET || process.env.CONTIPAY_API_SECRET || process.env.CONTIPAY_SECRET);

  const merchantId = process.env.CONTIPAY_MERCHANT_ID;

  if (!token || !secret) {
    // Log which names were checked so the Render env var name can be confirmed
    console.error('[ContiPay] Missing credentials. Checked env vars:', {
      CONTIPAY_TEST_AUTH_KEY:    !!process.env.CONTIPAY_TEST_AUTH_KEY,
      CONTIPAY_AUTH_KEY:         !!process.env.CONTIPAY_AUTH_KEY,
      CONTIPAY_TOKEN:            !!process.env.CONTIPAY_TOKEN,
      CONTIPAY_TEST_AUTH_SECRET: !!process.env.CONTIPAY_TEST_AUTH_SECRET,
      CONTIPAY_AUTH_SECRET:      !!process.env.CONTIPAY_AUTH_SECRET,
      CONTIPAY_SECRET:           !!process.env.CONTIPAY_SECRET,
    });
    throw new Error('CONTIPAY_AUTH_KEY / CONTIPAY_AUTH_SECRET must be set in backend/.env');
  }
  if (!merchantId)        throw new Error('CONTIPAY_MERCHANT_ID must be set in backend/.env');

  // CONTIPAY_ENV explicitly overrides NODE_ENV.
  // Set CONTIPAY_ENV=DEV in your .env to always use the sandbox, even on production infra.
  const contipayEnv = (process.env.CONTIPAY_ENV || '').toUpperCase();
  const env = contipayEnv === 'LIVE' ? 'LIVE'
            : contipayEnv === 'DEV'  ? 'DEV'
            : isProduction           ? 'LIVE'
            :                          'DEV';

  return { token, secret, merchantId: Number(merchantId), env };
}

/**
 * Map ContiPay webhook status to our internal status.
 * statusCode is most reliable: 1 = paid, 4 = declined.
 */
function mapContipayStatus(status, statusCode) {
  const numericCode = Number(statusCode);
  if (numericCode === 1) return 'completed';
  if (numericCode === 4) return 'failed';

  const s = (status || '').toLowerCase();
  if (['paid', 'success', 'successful', 'complete', 'completed'].includes(s)) return 'completed';
  if (['declined', 'failed', 'cancelled', 'canceled'].includes(s)) return 'failed';
  return 'pending';
}

function parseCustomerName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  const firstName  = parts[0] || '-';
  const surname    = parts.length > 1 ? parts[parts.length - 1] : '-';
  const middleName = parts.length > 2 ? parts.slice(1, -1).join(' ') : '-';
  return { firstName, surname, middleName };
}

/**
 * Initiate a ContiPay redirect payment for an order.
 *
 * Uses contipay-js (npm) with the redirect method:
 *   PUT {baseUrl}/acquire/payment  (Basic auth: token:secret)
 *
 * ContiPay returns a hosted checkout URL that the customer opens to
 * pick their payment method (EcoCash, card, etc.).
 */
export async function initiateContipayPayment({
  userId,
  orderId,
  amount,
  phone,
  email,
  fullName,
  reference,
  callbackUrl,
  returnUrl,
  cancelUrl,
}) {
  if (!userId)              throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!reference)           throw new Error('reference is required');

  const { token, secret, merchantId, env } = getContipayConfig();
  const { firstName, surname, middleName }  = parseCustomerName(fullName);

  // ContiPay expects local format, e.g. 0771234567
  const cell = (phone || '').replace(/^\+263/, '0').replace(/\s+/g, '');

  console.log('[ContiPay] Creating redirect payment:', { orderId, amount, reference, env });

  // Initialize client — call updateURL BEFORE setAppMode so it picks up the
  // correct UAT host (the npm package default is stale).
  const client = new Contipay(token, secret);
  client.updateURL(CONTIPAY_UAT_URL, CONTIPAY_LIVE_URL);
  client.setAppMode(env);           // DEV → UAT, LIVE → production
  client.setPaymentMethod('redirect'); // PUT

  // Build the redirect payload via the RedirectMethod helper
  const helper = new RedirectMethod(
    merchantId,
    callbackUrl,
    returnUrl  || callbackUrl,
    cancelUrl  || returnUrl || callbackUrl,
  );
  helper
    .setUpCustomer(firstName, surname, cell, 'ZW', email || '', middleName)
    .setUpTransaction(
      Number(amount),
      'USD',
      reference,
      `DOT order payment (ref: ${reference})`,
    );

  const payload = helper.preparePayload();
  console.log('[ContiPay] Payload:', JSON.stringify(payload));

  const responseData = await client.process(payload);

  // contipay-js swallows HTTP errors and returns { status: 'Error', message }
  if (!responseData || responseData.status === 'Error') {
    const detail = responseData?.message || 'Unknown error';
    console.error('[ContiPay] API error:', detail);
    throw new Error(`ContiPay payment creation failed: ${detail}`);
  }

  console.log('[ContiPay] API response:', JSON.stringify(responseData));

  const paymentUrl =
    responseData?.paymentUrl   ||
    responseData?.payment_url  ||
    responseData?.checkoutUrl  ||
    responseData?.checkout_url ||
    responseData?.redirectUrl  ||
    responseData?.redirect_url ||
    responseData?.url          ||
    responseData?.data?.paymentUrl ||
    responseData?.data?.url;

  if (!paymentUrl) {
    console.error('[ContiPay] No checkout URL in response:', JSON.stringify(responseData));
    throw new Error('ContiPay did not return a checkout URL');
  }

  console.log('[ContiPay] Checkout URL:', paymentUrl);

  // Record the pending payment
  const { data: paymentRecord, error: paymentError } = await supabase
    .from('payments')
    .insert({
      order_id:         orderId || null,
      customer_id:      userId,
      amount:           Number(amount),
      currency:         'USD',
      payment_method:   'contipay',
      payment_provider: 'ContiPay',
      transaction_id:   reference,
      status:           'pending',
      metadata: { reference, contipay_response: responseData },
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
 * Handle ContiPay server-to-server webhook callback.
 * Webhook payload includes: { status, statusCode, reference, contiPayRef, amount, charge, message }
 */
export async function handleContipayCallback(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const nested = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const status = payload.status ?? nested.status ?? payload.transactionStatus ?? nested.transactionStatus;
  const statusCode = payload.statusCode ?? nested.statusCode ?? payload.code ?? nested.code;
  const refCandidatesRaw = [
    payload.reference,
    nested.reference,
    payload.contiPayRef,
    nested.contiPayRef,
    payload.contipayRef,
    nested.contipayRef,
    payload.contipay_ref,
    nested.contipay_ref,
    payload.transaction_id,
    nested.transaction_id,
    payload.transactionId,
    nested.transactionId,
    payload.merchantReference,
    nested.merchantReference,
    payload.merchant_reference,
    nested.merchant_reference,
    payload.referenceNumber,
    nested.referenceNumber,
    payload.reference_number,
    nested.reference_number,
    payload.invoiceNumber,
    nested.invoiceNumber,
    payload.order_id,
    nested.order_id,
    payload.orderId,
    nested.orderId,
  ];
  const referenceCandidates = [...new Set(
    refCandidatesRaw
      .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
      .map((v) => String(v).trim()),
  )];

  if (referenceCandidates.length === 0) {
    console.error('[ContiPay] Callback missing reference. Payload keys:', Object.keys(payload || {}));
    if (nested && typeof nested === 'object') {
      console.error('[ContiPay] Callback nested payload keys:', Object.keys(nested || {}));
    }
    throw new Error('Missing reference in ContiPay callback');
  }

  let payment = null;
  let matchedReference = null;
  // Try all candidate refs and pick the first matching payment.
  for (const candidate of referenceCandidates) {
    const { data: found } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', candidate)
      .maybeSingle();
    if (found) {
      payment = found;
      matchedReference = candidate;
      break;
    }
  }

  if (!payment) {
    // Fallback 1: direct order id in callback query/body
    const orderIdCandidate =
      payload.order_id ??
      nested.order_id ??
      payload.orderId ??
      nested.orderId;
    if (orderIdCandidate) {
      const { data: byOrder } = await supabase
        .from('payments')
        .select('*')
        .eq('order_id', orderIdCandidate)
        .eq('payment_method', 'contipay')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byOrder) {
        payment = byOrder;
        matchedReference = `order_id:${orderIdCandidate}`;
      }
    }
  }

  if (!payment) {
    // Fallback 2: if callback carries amount, match unique recent pending contipay payment by amount.
    const amountCandidate = Number(
      payload.amount ?? nested.amount ?? payload.transactionAmount ?? nested.transactionAmount,
    );
    if (Number.isFinite(amountCandidate) && amountCandidate > 0) {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: pendingByAmount } = await supabase
        .from('payments')
        .select('*')
        .eq('payment_method', 'contipay')
        .eq('status', 'pending')
        .eq('amount', amountCandidate)
        .gte('created_at', thirtyMinutesAgo)
        .order('created_at', { ascending: false })
        .limit(2);
      if ((pendingByAmount || []).length === 1) {
        payment = pendingByAmount[0];
        matchedReference = `amount:${amountCandidate}`;
      }
    }
  }

  if (!payment) {
    console.warn('[ContiPay] Callback for unknown reference candidates:', referenceCandidates);
    return { payment: null };
  }

  const paymentStatus = mapContipayStatus(status, statusCode);
  console.log('[ContiPay] Callback received:', {
    reference: matchedReference,
    status,
    statusCode,
    paymentStatus,
  });

  const mergedMeta = {
    ...(payment?.metadata && typeof payment.metadata === 'object' ? payment.metadata : {}),
    ...payload,
    callback_reference_candidates: referenceCandidates,
    callback_matched_reference: matchedReference,
  };

  const { data: updatedPayment, error: updateError } = await supabase
    .from('payments')
    .update({ status: paymentStatus, metadata: mergedMeta })
    .eq('id', payment.id)
    .select('*')
    .maybeSingle();

  if (updateError) {
    console.error('[ContiPay] Failed to update payment from callback:', updateError);
    throw new Error(updateError.message || 'Failed to update payment');
  }

  if (!updatedPayment) {
    console.warn('[ContiPay] Callback matched payment but update returned no row:', payment.id);
    return { payment: null };
  }

  if (updatedPayment.order_id) {
    if (paymentStatus === 'completed') {
      await finalizeOrderPayment(updatedPayment);
    } else if (paymentStatus === 'failed') {
      await supabase
        .from('orders')
        .update({ payment_status: 'failed' })
        .eq('id', updatedPayment.order_id)
        .eq('payment_status', 'pending');
    }
  }

  return { payment: updatedPayment };
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

  if (order.payment_status === 'paid') return; // idempotent

  const { platformCommission, merchantEarnings } = computeSubtotalSplit(order.subtotal);

  const { data: store } = await supabase
    .from('stores')
    .select('merchant_id, store_name')
    .eq('id', order.store_id)
    .maybeSingle();

  const { data: updatedOrder, error: orderUpdateError } = await supabase
    .from('orders')
    .update({
      payment_status:             'paid',
      status:                     'pending',
      platform_commission_amount: platformCommission,
      merchant_earnings_amount:   merchantEarnings,
    })
    .eq('id', order.id)
    .select('*')
    .single();

  if (orderUpdateError) {
    console.error('[ContiPay] Failed to mark order paid:', orderUpdateError);
    return;
  }

  await notifyCustomerPaymentReceived(supabase, {
    customerId:  order.customer_id,
    orderId:     updatedOrder.id,
    orderNumber: updatedOrder.order_number,
    storeName:   store?.store_name,
  });

  if (store?.merchant_id && merchantEarnings > 0) {
    await recordMerchantEarningsForOrderPayment({
      merchantUserId: store.merchant_id,
      paymentId:      payment.id,
      amount:         merchantEarnings,
      orderNumber:    order.order_number,
    });
  }

  console.log('[ContiPay] Order finalized as paid:', order.id);
}
