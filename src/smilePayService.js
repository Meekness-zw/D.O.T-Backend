import axios from 'axios';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { finalizeOrderPaymentFromPesepay } from './paymentService.js';

const supabase = supabaseAdmin;

const SANDBOX_BASE = 'https://zbnet.zb.co.zw/wallet_sandbox_api/payments-gateway/';
const PRODUCTION_BASE = 'https://zbnet.zb.co.zw/wallet_gateway/payments-gateway/';

export function getSmilePayConfig() {
  const env = String(process.env.SMILEPAY_ENV || 'sandbox').trim().toLowerCase();
  const sandbox = env !== 'production';
  const apiKey = String(process.env.SMILEPAY_API_KEY || '').trim();
  const apiSecret = String(process.env.SMILEPAY_API_SECRET || '').trim();
  return {
    sandbox,
    env: sandbox ? 'sandbox' : 'production',
    baseUrl: String(process.env.SMILEPAY_BASE_URL || (sandbox ? SANDBOX_BASE : PRODUCTION_BASE)).trim(),
    apiKey,
    apiSecret,
    configured: Boolean(apiKey && apiSecret),
  };
}

export function toSmileCurrency(code) {
  const value = String(code || 'USD').trim().toUpperCase();
  if (value === '840' || value === 'USD') return '840';
  if (value === '924' || value === 'ZWG' || value === 'ZWL') return '924';
  return '840';
}

export function mapSmilePayStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  if (value === 'PAID' || value === 'SUCCESS' || value === 'SUCCESSFUL') return 'completed';
  if (value === 'FAILED' || value === 'CANCELED' || value === 'CANCELLED' || value === 'DECLINED') {
    return 'failed';
  }
  return 'pending';
}

function splitName(name) {
  const parts = String(name || 'Customer').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Customer', lastName: 'Customer' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ') || parts[0],
  };
}

function smilePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+263') && digits.length > 4) return `0${digits.slice(4)}`;
  if (digits.startsWith('263') && digits.length > 3) return `0${digits.slice(3)}`;
  return digits;
}

function compact(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value != null && value !== ''),
  );
}

async function smilePayRequest(method, endpoint, body) {
  const { baseUrl, apiKey, apiSecret, configured } = getSmilePayConfig();
  if (!configured) {
    throw new Error('Smile Cash is not configured. Set SMILEPAY_API_KEY and SMILEPAY_API_SECRET.');
  }
  const url = `${baseUrl.replace(/\/$/, '')}/${String(endpoint).replace(/^\//, '')}`;
  const response = await axios({
    method,
    url,
    data: body,
    timeout: Number(process.env.SMILEPAY_TIMEOUT_MS || 30000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-api-secret': apiSecret,
    },
    validateStatus: () => true,
  });
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  if (response.status >= 400) {
    const message = data.responseMessage || data.message || data.error || `Smile Cash error (${response.status})`;
    const error = new Error(typeof message === 'string' ? message : 'Smile Cash request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadSmilePayment(orderReference) {
  const { data, error } = await supabase
    .from('payments')
    .select('id, order_id, customer_id, amount, currency, status, transaction_id, payment_method')
    .eq('transaction_id', orderReference)
    .eq('payment_method', 'smilepay')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load Smile Cash payment');
  return data;
}

/**
 * Callbacks from Smile & Pay are unsigned. The body is only a hint:
 * the paid/failed decision always comes from an authenticated status check.
 */
export async function applySmilePayStatus(orderReference) {
  if (!orderReference) throw new Error('Missing Smile Cash order reference');
  if (!supabase) throw new Error('Server not configured');

  const payment = await loadSmilePayment(orderReference);
  if (!payment) {
    console.warn(`[SmilePay] status check for unknown reference ${orderReference}`);
    return { payment: null, paymentStatus: 'pending', order: null };
  }
  if (payment.status === 'completed') {
    return { payment, paymentStatus: 'completed', order: null, skipped: true };
  }

  const snapshot = await smilePayRequest(
    'GET',
    `payments/transaction/${encodeURIComponent(orderReference)}/status/check`,
  );
  const paymentStatus = mapSmilePayStatus(snapshot.status);
  const reportedAmount = Number(snapshot.amount);
  const expectedAmount = Number(payment.amount);
  if (
    paymentStatus === 'completed' &&
    Number.isFinite(reportedAmount) &&
    Number.isFinite(expectedAmount) &&
    Math.abs(reportedAmount - expectedAmount) > 0.02
  ) {
    console.error(
      `[SmilePay] amount mismatch ref=${orderReference} reported=${reportedAmount} expected=${expectedAmount}`,
    );
    throw new Error('Smile Cash reported an amount that does not match the order');
  }

  if (paymentStatus !== 'pending') {
    const { error: updateError } = await supabase
      .from('payments')
      .update({
        status: paymentStatus,
        metadata: {
          provider: 'smilepay',
          status: snapshot.status || null,
          paymentOption: snapshot.paymentOption || null,
          transactionReference: snapshot.reference || null,
        },
      })
      .eq('id', payment.id)
      .neq('status', 'completed');
    if (updateError) {
      console.error('[SmilePay] Failed to update payment:', updateError);
      throw new Error(updateError.message || 'Failed to update payment');
    }
  }

  let order = null;
  if (payment.order_id && paymentStatus !== 'pending') {
    const finalized = await finalizeOrderPaymentFromPesepay({
      payment,
      paymentStatus,
      transaction: snapshot,
    });
    order = finalized?.order || null;
  }

  return { payment, paymentStatus, order, snapshot };
}

export async function createSmilePayCheckout({
  userId,
  orderId,
  amount,
  currencyCode = 'USD',
  orderReference,
  itemName,
  resultUrl,
  returnUrl,
  customer = {},
}) {
  if (!supabase) throw new Error('Server not configured');
  if (!orderReference) throw new Error('orderReference is required');
  if (!resultUrl || !returnUrl) throw new Error('resultUrl and returnUrl are required');

  const { data: existing } = await supabase
    .from('payments')
    .select('id, status, transaction_id, metadata')
    .eq('order_id', orderId)
    .eq('payment_method', 'smilepay')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.status === 'completed') {
    return { alreadyPaid: true };
  }
  if (existing?.status === 'pending' && existing.metadata?.paymentUrl && existing.transaction_id) {
    try {
      const reconciled = await applySmilePayStatus(existing.transaction_id);
      if (reconciled.paymentStatus === 'completed' || reconciled.order?.payment_status === 'paid') {
        return { alreadyPaid: true };
      }
    } catch (error) {
      console.warn('[SmilePay] pre-start reconcile failed:', error?.message || error);
    }
    return {
      paymentUrl: existing.metadata.paymentUrl,
      orderReference: existing.transaction_id,
      reused: true,
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('payments')
    .insert({
      order_id: orderId,
      customer_id: userId,
      amount,
      currency: currencyCode,
      payment_method: 'smilepay',
      payment_provider: 'ZB Smile Cash',
      transaction_id: orderReference,
      status: 'pending',
      metadata: { provider: 'smilepay', phase: 'initiating' },
    })
    .select('id')
    .single();
  if (insertError) {
    throw new Error(insertError.message || 'Failed to save Smile Cash payment');
  }

  const { firstName, lastName } = splitName(customer.name);
  const payload = compact({
    orderReference,
    amount: Number(amount),
    returnUrl,
    resultUrl,
    cancelUrl: returnUrl,
    failureUrl: returnUrl,
    itemName: itemName || `Order ${orderReference}`,
    itemDescription: itemName || `Order ${orderReference}`,
    currencyCode: toSmileCurrency(currencyCode),
    firstName,
    lastName,
    mobilePhoneNumber: smilePhone(customer.phoneNumber),
    email: customer.email,
  });

  try {
    const response = await smilePayRequest('POST', 'payments/initiate-transaction', payload);
    if (response.responseCode && String(response.responseCode) !== '00') {
      throw new Error(response.responseMessage || 'Smile Cash could not start the payment');
    }
    const paymentUrl = response.paymentUrl;
    if (!paymentUrl) throw new Error('Smile Cash did not return a checkout URL');

    await supabase
      .from('payments')
      .update({
        metadata: {
          provider: 'smilepay',
          phase: 'redirect',
          paymentUrl,
          orderReference,
          transactionReference: response.transactionReference || null,
          responseCode: response.responseCode || null,
        },
      })
      .eq('id', inserted.id);

    console.log(`[SmilePay] initiate ref=${orderReference} order=${orderId}`);
    return { paymentUrl, orderReference, transactionReference: response.transactionReference || null };
  } catch (error) {
    await supabase
      .from('payments')
      .update({
        status: 'failed',
        metadata: { provider: 'smilepay', phase: 'initiate_failed', error: error.message },
      })
      .eq('id', inserted.id);
    throw error;
  }
}

export async function reconcileSmilePayOrder(orderId) {
  if (!supabase || !orderId) return null;
  const { data: payment, error } = await supabase
    .from('payments')
    .select('transaction_id, status')
    .eq('order_id', orderId)
    .eq('payment_method', 'smilepay')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load Smile Cash payment');
  if (!payment?.transaction_id || payment.status === 'completed') {
    return { paymentStatus: payment?.status || 'pending' };
  }
  return applySmilePayStatus(payment.transaction_id);
}
