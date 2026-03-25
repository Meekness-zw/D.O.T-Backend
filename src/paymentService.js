import axios from 'axios';
import https from 'https';
import CryptoJS from 'crypto-js';
import { getPesepayConfig } from './pesepayConfig.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { computeSubtotalSplit, recordMerchantEarningsForOrderPayment } from './orderPaymentSplit.js';

const supabase = supabaseAdmin;

// Always use the production URL — Pesepay production URL for BOTH sandbox/live credentials.
const PESEPAY_BASE_URL = 'https://api.pesepay.com/api/payments-engine/';

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
 * Create a seamless Pesepay transaction for a user.
 *
 * Params:
 * - userId: UUID from auth/users
 * - amount: number
 * - currencyCode: e.g. 'USD', 'ZWL'
 * - paymentMethodCode: Pesepay payment method code
 * - reasonForPayment: description, shown to user
 * - merchantReference: app-generated reference (e.g. order number)
 * - resultUrl: HTTPS URL Pesepay will POST result to (your backend endpoint)
 * - returnUrl: optional URL app/web will be redirected to after payment
 * - customer: { phoneNumber, email?, name? }
 */
export async function createPesepayTransaction({
  userId,
  amount,
  currencyCode = 'USD',
  paymentMethodCode,
  reasonForPayment,
  merchantReference,
  resultUrl,
  returnUrl,
  customer,
  orderId = null,
}) {
  if (!supabase) {
    throw new Error('Supabase admin client not configured');
  }

  if (!userId) throw new Error('userId is required');
  if (!amount || amount <= 0) throw new Error('amount must be > 0');
  if (!paymentMethodCode) throw new Error('paymentMethodCode is required');
  if (!reasonForPayment) throw new Error('reasonForPayment is required');
  if (!customer?.phoneNumber) throw new Error('customer.phoneNumber is required');

  const { integrationKey, encryptionKey } = getPesepayConfig();
  if (!integrationKey || !encryptionKey) {
    throw new Error('Pesepay integrationKey or encryptionKey not configured');
  }

  const http = createPesepayHttpClient(integrationKey);
  const security = new PesepaySecurity(encryptionKey);

  const makePaymentRequest = {
    amountDetails: {
      amount,
      currencyCode,
    },
    merchantReference: merchantReference || `DOT-${Date.now()}-${userId.slice(0, 8)}`,
    reasonForPayment,
    resultUrl,
    returnUrl: returnUrl || resultUrl,
    paymentMethodCode,
    customer: {
      phoneNumber: customer.phoneNumber,
      email: customer.email || '',
      name: customer.name || 'GUEST',
    },
    paymentMethodRequiredFields: {},
  };

  const payload = security.encryptData(makePaymentRequest);
  const response = await http.post('v2/payments/make-payment', { payload });

  if (!response?.data?.payload) {
    console.error('[Pesepay] Unexpected response:', response.status, JSON.stringify(response.data));
    throw new Error(`Pesepay error: invalid response (${response.status})`);
  }

  const transaction = security.decryptData(response.data.payload);

  const paymentStatus = mapPesepayStatusToPaymentStatus(transaction.transactionStatus);

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
      metadata: transaction,
    })
    .select('*')
    .single();

  if (paymentError) {
    console.error('[Pesepay] Failed to insert payment record:', paymentError);
    throw new Error(paymentError.message || 'Failed to save payment');
  }

  // Wallet top-up only (no order): credit customer wallet when gateway returns success immediately.
  let walletTx = null;
  if (paymentStatus === 'completed' && !orderId) {
    walletTx = await createWalletTransactionForPayment({
      userId,
      amount,
      currencyCode,
      paymentId: insertedPayment.id,
    });
  }

  return {
    transaction,
    payment: insertedPayment,
    walletTransaction: walletTx,
  };
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

  const { data: payment, error: updateError } = await supabase
    .from('payments')
    .update({
      status: paymentStatus,
      metadata: transaction,
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

