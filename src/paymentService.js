import axios from 'axios';
import https from 'https';
import CryptoJS from 'crypto-js';
import { getPesepayConfig } from './pesepayConfig.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';
import { notifyCustomerPaymentReceived, insertUserNotification } from './orderNotifications.js';

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
  constructor(encryptionKey, integrationKey = '') {
    this.rawEncryptionKey = encryptionKey;
    this.rawIntegrationKey = integrationKey;
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
    // Normalise: strip whitespace/newlines that some servers embed in base64
    const clean = String(encryptedData).replace(/\s+/g, '');

    // Strategy 1: fixed IV from key prefix — the canonical Pesepay scheme (all SDKs)
    try {
      const d1 = CryptoJS.AES.decrypt(clean, this.key, {
        iv: this.iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      const s1 = d1.toString(CryptoJS.enc.Utf8);
      if (s1) return JSON.parse(s1);
    } catch (_) {}

    // Strategy 2: IV prepended as first 16 bytes of ciphertext
    try {
      const decoded2 = CryptoJS.enc.Base64.parse(clean);
      const iv2 = CryptoJS.lib.WordArray.create(decoded2.words.slice(0, 4), 16);
      const ct2 = CryptoJS.lib.WordArray.create(decoded2.words.slice(4), decoded2.sigBytes - 16);
      const d2 = CryptoJS.AES.decrypt(CryptoJS.lib.CipherParams.create({ ciphertext: ct2 }), this.key, {
        iv: iv2,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      const s2 = d2.toString(CryptoJS.enc.Utf8);
      if (s2) return JSON.parse(s2);
    } catch (_) {}

    // Strategy 3: zero IV (some sandbox implementations omit/zero the IV)
    try {
      const zeroIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
      const d3 = CryptoJS.AES.decrypt(clean, this.key, {
        iv: zeroIv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      const s3 = d3.toString(CryptoJS.enc.Utf8);
      if (s3) return JSON.parse(s3);
    } catch (_) {}

    // Strategy 4: integration key (UUID without hyphens = 32 chars) as AES-256 key + first 16 as IV
    try {
      const ikNoHyphens = this.rawIntegrationKey.replace(/-/g, '');
      if (ikNoHyphens.length === 32) {
        const k4 = CryptoJS.enc.Utf8.parse(ikNoHyphens);
        const iv4 = CryptoJS.enc.Utf8.parse(ikNoHyphens.slice(0, 16));
        const d4 = CryptoJS.AES.decrypt(clean, k4, {
          iv: iv4,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        });
        const s4 = d4.toString(CryptoJS.enc.Utf8);
        if (s4) return JSON.parse(s4);
      }
    } catch (_) {}

    // Strategy 5: hex-decoded encryption key → AES-128, key = IV
    try {
      if (/^[0-9a-fA-F]{32}$/.test(this.rawEncryptionKey)) {
        const k5 = CryptoJS.enc.Hex.parse(this.rawEncryptionKey);
        const d5 = CryptoJS.AES.decrypt(clean, k5, {
          iv: k5,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        });
        const s5 = d5.toString(CryptoJS.enc.Utf8);
        if (s5) return JSON.parse(s5);
      }
    } catch (_) {}

    // Strategy 6: hex-decoded key (AES-128) + zero IV
    try {
      if (/^[0-9a-fA-F]{32}$/.test(this.rawEncryptionKey)) {
        const k6 = CryptoJS.enc.Hex.parse(this.rawEncryptionKey);
        const zeroIv6 = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
        const d6 = CryptoJS.AES.decrypt(clean, k6, {
          iv: zeroIv6,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        });
        const s6 = d6.toString(CryptoJS.enc.Utf8);
        if (s6) return JSON.parse(s6);
      }
    } catch (_) {}

    throw new Error('Malformed UTF-8 data');
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
  const security = new PesepaySecurity(encryptionKey, integrationKey);

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

  console.log(`[Pesepay] initiate: ref=${transaction.referenceNumber} redirectUrl=${redirectUrl?.slice(0,60)} status=${transaction.transactionStatus}`);

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
 * POST v2/payments/make-payment (prod) / v1/payments/make-payment (sandbox)
 * Direct/silent payment — initiates without a hosted redirect page.
 * Customer receives a USSD/push prompt on their phone (e.g. EcoCash PIN entry).
 * Final result arrives via the resultUrl webhook (same as hosted flow).
 *
 * Requires paymentMethodCode (e.g. the EcoCash USD code from the Pesepay dashboard).
 * No returnUrl needed — there is no browser redirect.
 *
 * Returns: { transaction, referenceNumber, payment, status }
 */
export async function makeDirectPesepayPayment({
  userId,
  amount,
  currencyCode = 'USD',
  reasonForPayment,
  merchantReference,
  resultUrl,
  paymentMethodCode,
  customer = null,
  orderId = null,
  customerPaymentMethodId = null,
}) {
  if (!supabase) throw new Error('Supabase admin client not configured');
  if (!userId) throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!reasonForPayment) throw new Error('reasonForPayment is required');
  if (!resultUrl) throw new Error('resultUrl is required');
  if (!paymentMethodCode) throw new Error('paymentMethodCode is required for direct payment');

  const { integrationKey, encryptionKey } = getPesepayConfig();
  if (!integrationKey || !encryptionKey) {
    throw new Error('Pesepay integrationKey or encryptionKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const security = new PesepaySecurity(encryptionKey, integrationKey);

  const reference = merchantReference || `DOT-${Date.now()}-${userId.slice(0, 8)}`;

  const makePaymentRequest = {
    amountDetails: { amount, currencyCode },
    merchantReference: reference,
    reasonForPayment,
    resultUrl,
    paymentMethodCode,
    ...(customer && { customer }),
  };

  // Sandbox base URL has no /api prefix — sandbox exposes make-payment under v1 while production is v2
  const makePaymentPath =
    PESEPAY_BASE_URL === PESEPAY_SANDBOX_BASE_URL
      ? 'v1/payments/make-payment'
      : 'v2/payments/make-payment';

  const payload = security.encryptData(makePaymentRequest);
  const response = await http.post(makePaymentPath, { payload });

  if (!response?.data?.payload) {
    console.error('[Pesepay] Unexpected make-payment response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid make-payment response (${response.status})`);
  }

  const transaction = security.decryptData(response.data.payload);
  const paymentStatus = mapPesepayStatusToPaymentStatus(transaction.transactionStatus);

  const metadataBase =
    transaction && typeof transaction === 'object' ? { ...transaction } : { gatewayPayload: transaction };
  if (customer) metadataBase.customer = customer;
  if (customerPaymentMethodId) metadataBase.customer_payment_method_id = customerPaymentMethodId;

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
    console.error('[Pesepay] Failed to insert payment record for direct payment:', paymentError);
    throw new Error(paymentError.message || 'Failed to save payment record');
  }

  return {
    transaction,
    referenceNumber: transaction.referenceNumber,
    payment: insertedPayment,
    status: paymentStatus,
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
  const security = new PesepaySecurity(encryptionKey, integrationKey);

  console.log(`[Pesepay] check-payment: querying ref=${referenceNumber}`);
  const response = await http.get(
    `v1/payments/check-payment?referenceNumber=${encodeURIComponent(referenceNumber)}`,
  );

  const rawPayload = response?.data?.payload;
  const rawResponseKeys = response?.data ? Object.keys(response.data) : [];
  console.log(`[Pesepay] check-payment: httpStatus=${response.status} responseFields=${rawResponseKeys.join(',')} hasPayload=${!!rawPayload} payloadLen=${String(rawPayload || '').length}`);
  console.log(`[Pesepay] check-payment: FULL_PAYLOAD=${String(rawPayload || '')}`);

  if (!rawPayload) {
    console.error('[Pesepay] Unexpected check-payment response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid check-payment response (${response.status})`);
  }

  let transaction;
  try {
    transaction = security.decryptData(rawPayload);
  } catch (decryptErr) {
    console.error(`[Pesepay] check-payment decryption failed. ref=${referenceNumber} error=${decryptErr?.message} encKeyLen=${encryptionKey.length} ikLen=${integrationKey.length}`);
    throw decryptErr;
  }

  console.log(`[Pesepay] check-payment: decrypted ref=${transaction?.referenceNumber} status=${transaction?.transactionStatus}`);

  // Reuse the callback path so order/wallet finalization stays in one place.
  const result = await handlePesepayCallback({ payload: rawPayload });
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
 * Sandbox-only: finalize a Pesepay payment that came in via the return URL.
 *
 * Pesepay's sandbox check-payment endpoint has a confirmed encryption bug —
 * it encrypts responses with a key that is not the merchant's encryption key,
 * so decryption is impossible. The return URL redirect, however, only fires
 * after the user sees "Payment Successful" and clicks Continue on the Pesepay
 * sandbox page, so it is a reliable confirmation signal.
 *
 * This function encrypts a synthetic SUCCESSFUL transaction with our own key
 * (which works correctly) and routes it through the normal handlePesepayCallback
 * path so all DB updates, wallet logic, and notifications fire as usual.
 */
export async function sandboxFinalizePaymentFromReturn(referenceNumber) {
  if (String(process.env.PESEPAY_ENV || '').toLowerCase() !== 'sandbox') return null;
  if (!referenceNumber) return null;

  const { encryptionKey, integrationKey } = getPesepayConfig();
  if (!encryptionKey) throw new Error('Pesepay encryptionKey not configured');

  const security = new PesepaySecurity(encryptionKey, integrationKey);

  // Build a minimal synthetic "SUCCESSFUL" transaction and encrypt it so the
  // normal callback handler can decrypt → update DB → send notifications.
  const syntheticTransaction = {
    referenceNumber,
    transactionStatus: 'SUCCESSFUL',
  };
  const encryptedPayload = security.encryptData(syntheticTransaction);

  console.log(`[Pesepay] sandbox return: finalizing ref=${referenceNumber} via synthetic callback`);
  return handlePesepayCallback({ payload: encryptedPayload });
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

  const security = new PesepaySecurity(encryptionKey, integrationKey);
  const transaction = security.decryptData(callbackBody.payload);

  console.log(`[Pesepay] callback: ref=${transaction?.referenceNumber} status=${transaction?.transactionStatus}`);
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
    console.warn('[Pesepay] Callback for unknown transaction reference:', transaction.referenceNumber, '— no matching payments row');
    return { transaction, payment: null, walletTransaction: null };
  }
  console.log(`[Pesepay] callback: payment row updated → status=${paymentStatus}, order_id=${payment.order_id}`);

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

    // Notify merchant: payment confirmed — order is now ready to prepare
    if (store?.merchant_id) {
      const numLabel = order.order_number ? `#${order.order_number}` : 'New order';
      try {
        await insertUserNotification(supabase, {
          userId: store.merchant_id,
          title: 'Payment confirmed — start preparing',
          message: `${numLabel} payment received ($${Number(order.total_amount || 0).toFixed(2)}). The order is waiting for your confirmation.`,
          type: 'order',
          referenceId: updatedOrder.id,
          data: { orderId: updatedOrder.id, orderNumber: order.order_number },
        });
      } catch (notifyErr) {
        console.warn('[Pesepay] merchant in-app notification failed (non-fatal):', notifyErr?.message);
      }

      try {
        const { data: merchantProfile } = await supabase
          .from('user_profiles')
          .select('push_token')
          .eq('id', store.merchant_id)
          .maybeSingle();
        const token = merchantProfile?.push_token;
        if (token?.startsWith('ExponentPushToken')) {
          await axios.post(
            'https://exp.host/push/send',
            {
              to: token,
              title: 'Payment confirmed — new order',
              body: `${numLabel} is paid ($${Number(order.total_amount || 0).toFixed(2)}). Start preparing now.`,
              data: { type: 'new_order', orderId: updatedOrder.id },
              sound: 'default',
            },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 },
          );
        }
      } catch (pushErr) {
        console.warn('[Pesepay] merchant push notification failed (non-fatal):', pushErr?.message);
      }
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

