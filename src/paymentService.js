import axios from 'axios';
import https from 'https';
import CryptoJS from 'crypto-js';
import { getPesepayConfig } from './pesepayConfig.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';
import { notifyCustomerPaymentReceived } from './orderNotifications.js';

const supabase = supabaseAdmin;

// Pesepay payments-engine base URLs. Note the sandbox host has no `/api` prefix.
// Set PESEPAY_ENV=sandbox to use the sandbox host (with sandbox keys), or
// override the full base with PESEPAY_BASE_URL.
const PESEPAY_PROD_BASE_URL = 'https://api.pesepay.com/api/payments-engine/';
const PESEPAY_SANDBOX_BASE_URL = 'https://api.test.sandbox.pesepay.com/payments-engine/';
const PESEPAY_BASE_URL =
  process.env.PESEPAY_BASE_URL ||
  (String(process.env.PESEPAY_ENV || '').toLowerCase() === 'sandbox'
    ? PESEPAY_SANDBOX_BASE_URL
    : PESEPAY_PROD_BASE_URL);

class PesepaySecurity {
  constructor(encryptionKey) {
    this.key = CryptoJS.enc.Utf8.parse(encryptionKey);
    this.iv = CryptoJS.enc.Utf8.parse(encryptionKey.slice(0, 16));
  }

  encryptData(data) {
    const jsonString = JSON.stringify(data);
    const encrypted = CryptoJS.AES.encrypt(jsonString, this.key, {
      iv: this.iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    return encrypted.toString();
  }

  decryptData(encryptedData) {
    const decrypted = CryptoJS.AES.decrypt(encryptedData, this.key, {
      iv: this.iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const jsonString = decrypted.toString(CryptoJS.enc.Utf8);
    return JSON.parse(jsonString);
  }
}

function createPesepayHttpClient(integrationKey) {
  // Pesepay's server returns non-RFC-compliant HTTP response headers in some cases.
  // insecureHTTPParser allows Node to parse these without throwing HPE_CR_EXPECTED.
  const agent = new https.Agent({ insecureHTTPParser: true });

  return axios.create({
    baseURL: PESEPAY_BASE_URL,
    httpsAgent: agent,
    headers: {
      authorization: integrationKey.trim(),
      'content-type': 'application/json',
    },
    // Accept any 2xx/3xx; we will handle codes explicitly.
    validateStatus: () => true,
    transformResponse: [
      (data) => {
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      },
    ],
  });
}


function mapPesepayStatusToPaymentStatus(transactionStatus) {
  const s = (transactionStatus || '').toUpperCase();
  if (s === 'SUCCESSFUL' || s === 'SUCCESS') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
  if (s === 'REFUNDED') return 'refunded';
  return 'pending';
}

/**
 * Initiate a hosted (redirect) Pesepay transaction for a user.
 *
 * Uses POST v1/payments/initiate — Pesepay returns a hosted checkout page
 * (redirectUrl) where the customer picks their method (card, EcoCash, etc.).
 * The final result arrives later on the resultUrl webhook (handlePesepayCallback),
 * and can also be polled via checkPesepayStatus(referenceNumber).
 *
 * Params:
 * - userId: UUID from auth/users
 * - amount: number
 * - currencyCode: e.g. 'USD', 'ZWL'
 * - reasonForPayment: description, shown to user
 * - merchantReference: app-generated reference (e.g. order number)
 * - resultUrl: HTTPS URL Pesepay will POST the encrypted result to (your backend endpoint)
 * - returnUrl: URL the browser is redirected to after payment (deep-links back into the app)
 * - customer: optional { phoneNumber?, email?, name? } — informational only for the hosted page
 * - customerPaymentMethodId: optional UUID linking to customer_payment_methods
 *
 * Returns: { redirectUrl, pollUrl, referenceNumber, transaction, payment }
 */
export async function createPesepayTransaction({
  userId,
  amount,
  currencyCode = 'USD',
  reasonForPayment,
  merchantReference,
  resultUrl,
  returnUrl,
  customer = null,
  orderId = null,
  customerPaymentMethodId = null,
}) {
  if (!supabase) {
    throw new Error('Supabase admin client not configured');
  }

  if (!userId) throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!reasonForPayment) throw new Error('reasonForPayment is required');
  if (!resultUrl) throw new Error('resultUrl is required');

  const { integrationKey, encryptionKey } = getPesepayConfig();
  if (!integrationKey || !encryptionKey) {
    throw new Error('Pesepay integrationKey or encryptionKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const security = new PesepaySecurity(encryptionKey);

  const reference = merchantReference || `DOT-${Date.now()}-${userId.slice(0, 8)}`;

  const initiateRequest = {
    amountDetails: {
      amount,
      currencyCode,
    },
    merchantReference: reference,
    reasonForPayment,
    resultUrl,
    returnUrl: returnUrl || resultUrl,
  };

  const payload = security.encryptData(initiateRequest);
  const response = await http.post('v1/payments/initiate', { payload });

  if (!response?.data?.payload) {
    console.error('[Pesepay] Unexpected initiate response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid response (${response.status})`);
  }

  const transaction = security.decryptData(response.data.payload);
  const redirectUrl = transaction.redirectUrl || transaction.redirect_url || null;
  const pollUrl = transaction.pollUrl || transaction.poll_url || null;

  if (!redirectUrl) {
    console.error('[Pesepay] initiate returned no redirectUrl:', JSON.stringify(transaction));
    throw new Error('Pesepay did not return a checkout URL');
  }

  const paymentStatus = mapPesepayStatusToPaymentStatus(transaction.transactionStatus);

  const metadataBase =
    transaction && typeof transaction === 'object' ? { ...transaction } : { gatewayPayload: transaction };
  if (customer) metadataBase.customer = customer;
  if (customerPaymentMethodId) {
    metadataBase.customer_payment_method_id = customerPaymentMethodId;
  }

  const { data: insertedPayment, error: paymentError } = await supabase
    .from('payments')
    .insert({
      order_id: orderId,
      customer_id: userId,
      amount,
      currency: currencyCode,
      payment_method: 'pesepay',
      payment_provider: 'Pesepay',
      transaction_id: transaction.referenceNumber,
      status: paymentStatus,
      metadata: metadataBase,
    })
    .select('*')
    .single();

  if (paymentError) {
    console.error('[Pesepay] Failed to insert payment record:', paymentError);
    throw new Error(paymentError.message || 'Failed to save payment');
  }

  return {
    transaction,
    redirectUrl,
    pollUrl,
    referenceNumber: transaction.referenceNumber,
    payment: insertedPayment,
  };
}

/**
 * GET v1/currencies/active — list currencies the merchant account can collect in.
 * Returns the raw array from Pesepay (e.g. [{ code: 'USD', name: ... }, ...]).
 */
export async function listPesepayActiveCurrencies() {
  const { integrationKey } = getPesepayConfig();
  if (!integrationKey) {
    throw new Error('Pesepay integrationKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const response = await http.get('v1/currencies/active');

  if (response.status !== 200 || !Array.isArray(response.data)) {
    console.error('[Pesepay] Unexpected currencies response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid currencies response (${response.status})`);
  }
  return response.data;
}

/**
 * GET v1/payment-methods/for-currency?currencyCode=... — list payment methods
 * (with their codes, e.g. PZW211) available for a currency. Use this to find
 * the code for PESEPAY_USD_PAYMENT_METHOD_CODE instead of dashboard digging.
 */
export async function listPesepayPaymentMethods(currencyCode = 'USD') {
  const { integrationKey } = getPesepayConfig();
  if (!integrationKey) {
    throw new Error('Pesepay integrationKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const response = await http.get(
    `v1/payment-methods/for-currency?currencyCode=${encodeURIComponent(currencyCode)}`,
  );

  if (response.status !== 200 || !Array.isArray(response.data)) {
    console.error('[Pesepay] Unexpected payment-methods response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid payment-methods response (${response.status})`);
  }
  return response.data;
}

/**
 * Poll Pesepay for the status of a transaction by reference number, then
 * reconcile our local payment row + order/wallet exactly like the webhook does.
 * Useful as a fallback when the result webhook is delayed or missed.
 *
 * GET v1/payments/check-payment?referenceNumber=...
 * Returns: { transaction, paymentStatus } or null if nothing to do.
 */
export async function checkPesepayStatus(referenceNumber) {
  if (!referenceNumber) throw new Error('referenceNumber is required');

  const { integrationKey, encryptionKey } = getPesepayConfig();
  if (!integrationKey || !encryptionKey) {
    throw new Error('Pesepay integrationKey or encryptionKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const security = new PesepaySecurity(encryptionKey);

  const response = await http.get(
    `v1/payments/check-payment?referenceNumber=${encodeURIComponent(referenceNumber)}`,
  );

  if (!response?.data?.payload) {
    console.error('[Pesepay] Unexpected check-payment response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid check-payment response (${response.status})`);
  }

  const transaction = security.decryptData(response.data.payload);
  // Reuse the callback path so order/wallet finalization stays in one place.
  const result = await handlePesepayCallback({ payload: response.data.payload });
  return { transaction, ...result };
}

async function createWalletTransactionForPayment({ userId, amount, currencyCode, paymentId }) {
  // Fetch latest balance
  const { data: lastTx } = await supabase
    .from('wallet_transactions')
    .select('balance_after')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevBalance = lastTx?.balance_after || 0;
  const newBalance = prevBalance + amount;

  const { data, error } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: userId,
      user_type: 'customer',
      transaction_type: 'deposit',
      amount,
      balance_after: newBalance,
      description: `Pesepay payment (${currencyCode})`,
      reference_id: paymentId,
      status: 'completed',
    })
    .select('*')
    .single();

  if (error) {
    console.error('[Pesepay] Failed to insert wallet transaction:', error);
    return null;
  }

  return data;
}

/**
 * Handle Pesepay callback sent to your resultUrl.
 * Expects body like { payload: '<encrypted-string>' }.
 * Updates payments row and, if just completed, writes wallet transaction.
 */
export async function handlePesepayCallback(callbackBody) {
  const { integrationKey, encryptionKey } = getPesepayConfig();
  if (!integrationKey || !encryptionKey) {
    throw new Error('Pesepay integrationKey or encryptionKey not configured');
  }

  if (!callbackBody?.payload) {
    throw new Error('Missing payload in Pesepay callback');
  }

  const security = new PesepaySecurity(encryptionKey);
  const transaction = security.decryptData(callbackBody.payload);

  const paymentStatus = mapPesepayStatusToPaymentStatus(transaction.transactionStatus);

  const { data: prevPay } = await supabase
    .from('payments')
    .select('metadata')
    .eq('transaction_id', transaction.referenceNumber)
    .maybeSingle();

  const mergedMeta = {
    ...(prevPay?.metadata && typeof prevPay.metadata === 'object' ? prevPay.metadata : {}),
    ...(typeof transaction === 'object' && transaction !== null ? transaction : { result: transaction }),
  };

  const { data: payment, error: updateError } = await supabase
    .from('payments')
    .update({
      status: paymentStatus,
      metadata: mergedMeta,
    })
    .eq('transaction_id', transaction.referenceNumber)
    .select('*')
    .maybeSingle();

  if (updateError) {
    console.error('[Pesepay] Failed to update payment from callback:', updateError);
    throw new Error(updateError.message || 'Failed to update payment');
  }

  if (!payment) {
    console.warn('[Pesepay] Callback for unknown transaction reference:', transaction.referenceNumber);
    return { transaction, payment: null, walletTransaction: null };
  }

  // Order checkout: update order + merchant ledger — never credit customer wallet for order payments.
  if (payment.order_id) {
    const orderResult = await finalizeOrderPaymentFromPesepay({
      payment,
      paymentStatus,
      transaction,
    });
    return {
      transaction,
      payment,
      walletTransaction: orderResult?.walletTransaction ?? null,
      order: orderResult?.order ?? null,
    };
  }

  // Wallet top-up (no order row)
  let walletTx = null;
  if (paymentStatus === 'completed') {
    walletTx = await createWalletTransactionForPayment({
      userId: payment.customer_id,
      amount: payment.amount,
      currencyCode: payment.currency,
      paymentId: payment.id,
    });
  }

  return { transaction, payment, walletTransaction: walletTx };
}

/**
 * After Pesepay confirms a payment linked to an order: mark order paid, apply merchant split.
 */
async function finalizeOrderPaymentFromPesepay({ payment, paymentStatus, transaction }) {
  if (!supabase || !payment?.order_id) return null;

  const { data: order, error: orderLoadError } = await supabase
    .from('orders')
    .select(
      'id, order_number, customer_id, store_id, status, subtotal, delivery_fee, total_amount, payment_status, payment_method',
    )
    .eq('id', payment.order_id)
    .maybeSingle();

  if (orderLoadError || !order) {
    console.error('[Pesepay] Failed to load order for callback:', orderLoadError);
    return null;
  }

  if (paymentStatus === 'completed') {
    if (order.payment_status === 'paid') {
      return { order, walletTransaction: null, skipped: true };
    }

    const { platformCommission, merchantEarnings } = computeSubtotalSplit(order.subtotal);

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', order.store_id)
      .maybeSingle();

    if (storeError || !store?.merchant_id) {
      console.error('[Pesepay] Order callback: store/merchant missing:', storeError);
    }

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
      console.error('[Pesepay] Failed to mark order paid:', orderUpdateError);
      throw new Error(orderUpdateError.message || 'Failed to update order');
    }

    const { data: storeForNotify } = await supabase
      .from('stores')
      .select('store_name')
      .eq('id', order.store_id)
      .maybeSingle();

    await notifyCustomerPaymentReceived(supabase, {
      customerId: order.customer_id,
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.order_number,
      storeName: storeForNotify?.store_name,
    });

    let merchantTx = null;
    if (store?.merchant_id && merchantEarnings > 0) {
      merchantTx = await recordMerchantEarningsForOrderPayment({
        merchantUserId: store.merchant_id,
        paymentId: payment.id,
        amount: merchantEarnings,
        orderNumber: order.order_number,
      });
    }

    return { order: updatedOrder, walletTransaction: merchantTx };
  }

  if (paymentStatus === 'failed') {
    await supabase
      .from('orders')
      .update({ payment_status: 'failed' })
      .eq('id', order.id)
      .eq('payment_status', 'pending');
  }

  return { order, walletTransaction: null };
}

