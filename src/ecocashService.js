import axios from 'axios';
import crypto from 'crypto';
import { normalizeZwPhone, detectProviderFromPhone } from './walletProvider.js';

/**
 * EcoCash Online Payments (C2B), direct with EcoCash — not through Pesepay.
 * Docs: https://developers.ecocash.co.zw/docs/online-payments
 *
 * The customer gets an EcoCash prompt on their phone and approves it with
 * their EcoCash PIN. We then confirm the outcome with EcoCash's lookup call
 * (polled by the app, and on EcoCash's notifyUrl callback) — a callback body
 * is never trusted on its own.
 *
 * Configuration (Render environment). The live base URL and credentials come
 * from EcoCash's go-live email; nothing here defaults to live.
 *   ECOCASH_BASE_URL         e.g. https://developers.ecocash.co.zw/sandbox/payment/v1
 *   ECOCASH_USERNAME / ECOCASH_PASSWORD   Basic auth
 *   ECOCASH_MERCHANT_CODE, ECOCASH_MERCHANT_PIN, ECOCASH_MERCHANT_NUMBER,
 *   ECOCASH_MERCHANT_NAME
 *   optional: ECOCASH_TERMINAL_ID (only if EcoCash issued one; left out of
 *   the request otherwise), ECOCASH_SUPER_MERCHANT_NAME (ECOCASH), ECOCASH_LOCATION (Harare),
 *   ECOCASH_CURRENCY (USD), ECOCASH_MSISDN_FORMAT ('local' = 771234567, or
 *   'international' = 263771234567)
 */

const REQUIRED = [
  'ECOCASH_BASE_URL',
  'ECOCASH_USERNAME',
  'ECOCASH_PASSWORD',
  'ECOCASH_MERCHANT_CODE',
  'ECOCASH_MERCHANT_PIN',
  'ECOCASH_MERCHANT_NUMBER',
  'ECOCASH_MERCHANT_NAME',
];

export function ecocashMissingConfig(env = process.env) {
  return REQUIRED.filter((key) => !String(env[key] || '').trim());
}

export function ecocashConfigured(env = process.env) {
  return ecocashMissingConfig(env).length === 0;
}

/** The customer's number the way EcoCash wants it, or null if it isn't an EcoCash number. */
export function ecocashEndUserId(phone, format = process.env.ECOCASH_MSISDN_FORMAT) {
  const local = normalizeZwPhone(phone); // 0771234567
  if (!/^07\d{8}$/.test(local)) return null;
  if (detectProviderFromPhone(local)?.id !== 'ecocash') return null;
  const nine = local.slice(1); // 771234567
  return format === 'international' ? `263${nine}` : nine;
}

/** A unique id for one charge attempt (EcoCash: unique per transaction). */
export function newClientCorrelator() {
  return `DOT${Date.now()}${String(crypto.randomInt(0, 1000000)).padStart(6, '0')}`;
}

/**
 * Our payment status for an EcoCash response: 'completed' | 'failed' | 'refunded' | 'pending'.
 * The docs show "Charged" with responseCode "00" for success; the other
 * wordings cover EcoCash's older C2B statuses. Anything unrecognised stays
 * pending, so it's looked up again rather than guessed.
 */
export function mapEcocashStatus(body) {
  const status = String(body?.transactionOperationStatus || body?.status || '').trim().toUpperCase();
  if (['CHARGED', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL'].includes(status)) return 'completed';
  if (['REFUNDED', 'REVERSED'].includes(status)) return 'refunded';
  if (/FAIL|CANCEL|REJECT|DECLIN|INSUFFICIENT|EXPIRED|TIMEOUT|INVALID/.test(status)) return 'failed';
  return 'pending';
}

function client(env = process.env) {
  return axios.create({
    baseURL: String(env.ECOCASH_BASE_URL).replace(/\/+$/, ''),
    timeout: 30000,
    auth: { username: env.ECOCASH_USERNAME, password: env.ECOCASH_PASSWORD },
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
}

function merchantFields(env = process.env) {
  return {
    merchantCode: env.ECOCASH_MERCHANT_CODE,
    merchantPin: env.ECOCASH_MERCHANT_PIN,
    merchantNumber: env.ECOCASH_MERCHANT_NUMBER,
    countryCode: 'ZW',
    ...(String(env.ECOCASH_TERMINAL_ID || '').trim() ? { terminalID: env.ECOCASH_TERMINAL_ID.trim() } : {}),
    location: env.ECOCASH_LOCATION || 'Harare',
    superMerchantName: env.ECOCASH_SUPER_MERCHANT_NAME || 'ECOCASH',
    merchantName: env.ECOCASH_MERCHANT_NAME,
  };
}

/** The charge request body (exported for tests). */
export function buildChargeBody({ clientCorrelator, endUserId, amount, description, notifyUrl }, env = process.env) {
  return {
    clientCorrelator,
    referenceCode: clientCorrelator,
    tranType: 'MER',
    endUserId,
    paymentAmount: {
      charginginformation: {
        amount: Math.round(Number(amount) * 100) / 100,
        currency: env.ECOCASH_CURRENCY || 'USD',
        description: String(description || 'DOT order').slice(0, 100),
      },
      chargeMetaData: {
        channel: 'WEB',
        purchaseCategoryCode: 'Online Payment',
        onBeHalfOf: env.ECOCASH_SUPER_MERCHANT_NAME || 'ECOCASH',
      },
    },
    ...merchantFields(env),
    ...(notifyUrl ? { notifyUrl } : {}),
  };
}

/** A readable reason from an EcoCash error, for the customer. */
export function ecocashErrorMessage(error) {
  const data = error?.response?.data || {};
  const status = error?.response?.status;
  if (status === 422) {
    return data.message || 'EcoCash declined the payment. Check your balance and limits, then try again.';
  }
  if (status === 401) return 'EcoCash payments are not available right now. Please pay another way.';
  return data.message || 'EcoCash could not start the payment. Please try again.';
}

/** Ask EcoCash to charge the customer. Resolves EcoCash's response body. */
export async function chargeEcocash(params, env = process.env) {
  const response = await client(env).post('/transactions/amount/', buildChargeBody(params, env));
  return response.data;
}

/** EcoCash's current view of a charge. Resolves the response body. */
export async function lookupEcocash({ endUserId, clientCorrelator }, env = process.env) {
  const response = await client(env).get(
    `/${encodeURIComponent(endUserId)}/transactions/amount/${encodeURIComponent(clientCorrelator)}`,
  );
  return response.data;
}
