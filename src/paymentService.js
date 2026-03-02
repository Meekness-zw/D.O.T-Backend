import axios from 'axios';
import https from 'https';
import CryptoJS from 'crypto-js';
import { getPesepayConfig } from './pesepayConfig.js';
import { supabaseAdmin } from './supabaseAdminClient.js';

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

  // For now, only create a wallet transaction when immediately successful.
  let walletTx = null;
  if (paymentStatus === 'completed') {
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

