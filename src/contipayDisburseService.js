/**
 * Contipay outbound disbursements (POST /disburse/payment).
 *
 * The npm `contipay-js` package only exposes /acquire/payment, so we call
 * /disburse/payment directly. The endpoint requires a `checksum` header:
 *   checksum = base64( RSA-SHA256-sign(
 *     token + reference + merchantId + accountNumber + amount,
 *     privateKey
 *   ))
 *
 * The matching public key must be registered with your Contipay merchant
 * account. Generate a keypair with:
 *   openssl genrsa -out contipay_disburse_private.pem 2048
 *   openssl rsa -in contipay_disburse_private.pem -pubout -out contipay_disburse_public.pem
 * Then upload contipay_disburse_public.pem to your Contipay dashboard (or
 * email it to support@contipay.co.zw), and paste the PEM contents of the
 * private key into CONTIPAY_DISBURSE_PRIVATE_KEY in backend/.env.
 *
 * Env layout (multi-line PEM in a single env var — use \n for newlines or
 * a literal multi-line value in a .env file that supports it):
 *   CONTIPAY_DISBURSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
 */

import axios from 'axios';
import crypto from 'crypto';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { getContipayConfig } from './contipayService.js';
import { normalizeZwPhone } from './walletProvider.js';

const supabase = supabaseAdmin;

const CONTIPAY_UAT_URL  = 'https://api-uat.contipay.net';
const CONTIPAY_LIVE_URL = 'https://api-v2.contipay.co.zw';

const REFERENCE_PREFIX = 'DOT-PO-';

function getDisbursePrivateKey() {
  const raw = process.env.CONTIPAY_DISBURSE_PRIVATE_KEY;
  if (!raw) {
    throw new Error('CONTIPAY_DISBURSE_PRIVATE_KEY is not set in backend/.env');
  }
  // Support both literal \n escapes and real newlines.
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
    throw new Error('CONTIPAY_DISBURSE_PRIVATE_KEY does not look like a PEM private key');
  }
  return pem;
}

function signChecksum({ token, reference, merchantId, accountNumber, amount, privateKeyPem }) {
  const data = `${token}${reference}${merchantId}${accountNumber}${amount}`;
  return crypto.createSign('RSA-SHA256').update(data).sign(privateKeyPem, 'base64');
}

function buildReference({ orderId, recipientType }) {
  const shortOrder = String(orderId || '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const tag = recipientType === 'merchant' ? 'M' : 'C';
  const nonce = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${REFERENCE_PREFIX}${shortOrder}-${tag}-${nonce}`;
}

export function isDisburseReference(ref) {
  return typeof ref === 'string' && ref.startsWith(REFERENCE_PREFIX);
}

function parseCustomerName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  const firstName  = parts[0] || '-';
  const surname    = parts.length > 1 ? parts[parts.length - 1] : '-';
  const middleName = parts.length > 2 ? parts.slice(1, -1).join(' ') : '-';
  return { firstName, surname, middleName };
}

/**
 * Send money out to a mobile wallet.
 *
 * @param {Object} args
 * @param {string} args.recipientUserId     — the user receiving the money
 * @param {'courier'|'merchant'} args.recipientType
 * @param {string} [args.orderId]           — order this payout is for (audit + idempotency)
 * @param {string} [args.payoutMethodId]    — courier_payout_methods.id / merchant_payout_methods.id
 * @param {number} args.amount              — USD amount (> 0)
 * @param {string} args.accountNumber       — destination phone in local format (077…)
 * @param {string} args.providerCode        — Contipay provider code (EC/NM/TC/IB/OM) — pass empty for 'Transfer' routing
 * @param {string} [args.providerName]      — friendly name (defaults from providerCode)
 * @param {string} [args.accountName]       — wallet holder name (used in payload + audit)
 * @param {string} [args.callbackUrl]       — webhook url; defaults to API_BASE_URL/payments/contipay/callback
 * @param {string} [args.description]       — payment description shown on wallet statement
 */
export async function disburseToWallet({
  recipientUserId,
  recipientType,
  orderId,
  payoutMethodId,
  amount,
  accountNumber,
  providerCode,
  providerName,
  accountName,
  callbackUrl,
  description,
}) {
  if (!recipientUserId) throw new Error('recipientUserId is required');
  if (!['courier', 'merchant'].includes(recipientType)) throw new Error('recipientType must be courier|merchant');
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be > 0');
  const normalizedAccount = normalizeZwPhone(accountNumber);
  if (!normalizedAccount) throw new Error('accountNumber is required');

  if (supabase && orderId) {
    const { data: existing } = await supabase
      .from('payout_disbursements')
      .select('id, status, reference, contipay_ref, amount')
      .eq('order_id', orderId)
      .eq('recipient_user_id', recipientUserId)
      .eq('recipient_type', recipientType)
      .eq('status', 'completed')
      .maybeSingle();
    if (existing) {
      return { ok: true, alreadyPaid: true, disbursement: existing };
    }
  }

  const { token, secret, merchantId, env } = getContipayConfig();
  const privateKeyPem = getDisbursePrivateKey();

  const reference = buildReference({ orderId, recipientType });
  const desc = (description || `DOT payout (${recipientType}) for order ${orderId || ''}`).slice(0, 120);
  const { firstName, surname, middleName } = parseCustomerName(accountName);

  // Contipay routes by phone when providerCode is "TF" (generic Transfer).
  // Passing a specific code (EC/NM/TC) forces that wallet — useful when we
  // know the operator from the prefix.
  const code = (providerCode || 'TF').toUpperCase();
  const name = providerName || (code === 'EC' ? 'EcoCash'
                              : code === 'NM' ? 'OneMoney'
                              : code === 'TC' ? 'Telecash'
                              : code === 'IB' ? 'InnBucks'
                              : code === 'OM' ? "O'Mari"
                              :                 'Transfer');

  const payload = {
    customer: {
      nationalId: '-',
      firstName,
      middleName,
      surname,
      email: `${normalizedAccount}@contipay.co.zw`,
      cell: normalizedAccount,
      countryCode: 'ZW',
    },
    transaction: {
      providerCode:  code,
      providerName:  name,
      amount:        amt,
      currencyCode:  'USD',
      description:   desc,
      webhookUrl:    callbackUrl || `${process.env.API_BASE_URL || ''}/payments/contipay/callback`,
      merchantId:    Number(merchantId),
      reference,
    },
    accountDetails: {
      accountNumber: normalizedAccount,
      accountName:   accountName || '-',
      accountExtra: {
        smsNumber: normalizedAccount,
        expiry:    '-',
        cvv:       '',
      },
    },
  };

  const checksum = signChecksum({
    token,
    reference,
    merchantId: Number(merchantId),
    accountNumber: normalizedAccount,
    amount: amt,
    privateKeyPem,
  });

  const baseURL = env === 'LIVE' ? CONTIPAY_LIVE_URL : CONTIPAY_UAT_URL;

  let disbursementId = null;
  if (supabase) {
    const { data: row, error: insertError } = await supabase
      .from('payout_disbursements')
      .insert({
        order_id:          orderId || null,
        recipient_user_id: recipientUserId,
        recipient_type:    recipientType,
        payout_method_id:  payoutMethodId || null,
        amount:            amt,
        currency:          'USD',
        provider:          name,
        provider_code:     code,
        account_number:    normalizedAccount,
        account_name:      accountName || null,
        reference,
        status:            'pending',
        raw_request:       payload,
      })
      .select('id')
      .single();
    if (insertError) {
      console.error('[ContiPay disburse] Failed to insert audit row:', insertError);
      throw new Error(insertError.message || 'Failed to record disbursement');
    }
    disbursementId = row?.id || null;
  }

  console.log('[ContiPay disburse] PUT', `${baseURL}/disburse/payment`, { reference, recipientType, amount: amt });

  let responseData = null;
  let contipayRef = null;
  let httpStatus = null;
  try {
    const res = await axios.request({
      method: 'PUT',
      baseURL,
      url: '/disburse/payment',
      auth: { username: token, password: secret },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        checksum,
      },
      data: payload,
      timeout: 30000,
    });
    responseData = res.data;
    httpStatus = res.status;
    contipayRef = responseData?.contiPayRef
                ?? responseData?.contipayRef
                ?? responseData?.reference
                ?? responseData?.data?.reference
                ?? null;
    console.log('[ContiPay disburse] response:', JSON.stringify(responseData).slice(0, 500));
  } catch (err) {
    const errPayload = err?.response?.data || { message: err?.message || 'Unknown error' };
    console.error('[ContiPay disburse] HTTP error:', err?.response?.status, errPayload);
    if (supabase && disbursementId) {
      await supabase
        .from('payout_disbursements')
        .update({
          status:        'failed',
          status_code:   err?.response?.status || null,
          error_message: errPayload?.message || err.message || 'Contipay disburse failed',
          raw_response:  errPayload,
          updated_at:    new Date().toISOString(),
        })
        .eq('id', disbursementId);
    }
    throw new Error(`Contipay disburse failed: ${errPayload?.message || err.message}`);
  }

  // Contipay disbursements are typically asynchronous: response is "accepted",
  // and the final status arrives on the webhook (see handleContipayCallback,
  // which routes DOT-PO-* refs to finalizeDisbursementCallback below).
  // Store the response and Contipay ref; status stays 'pending' until webhook.
  if (supabase && disbursementId) {
    await supabase
      .from('payout_disbursements')
      .update({
        status_code:  httpStatus,
        contipay_ref: contipayRef,
        raw_response: responseData,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', disbursementId);
  }

  return {
    ok: true,
    disbursementId,
    reference,
    contipayRef,
    response: responseData,
  };
}

/**
 * Mark a disbursement complete/failed when its Contipay webhook arrives, and
 * post a 'payout' debit to wallet_transactions so the ledger balance stays
 * consistent with the disbursed amount.
 *
 * Called from contipayService.handleContipayCallback when the reference is a
 * disbursement reference (DOT-PO-*).
 */
export async function finalizeDisbursementCallback({ reference, statusCode, status, rawPayload }) {
  if (!supabase) return { disbursement: null };

  const { data: row } = await supabase
    .from('payout_disbursements')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();

  if (!row) {
    console.warn('[ContiPay disburse] Webhook for unknown reference:', reference);
    return { disbursement: null };
  }

  const finalStatus = Number(statusCode) === 1 ? 'completed'
                    : Number(statusCode) === 4 ? 'failed'
                    : String(status || '').toLowerCase() === 'paid'      ? 'completed'
                    : String(status || '').toLowerCase() === 'completed' ? 'completed'
                    : String(status || '').toLowerCase() === 'failed'    ? 'failed'
                    : 'pending';

  const updates = {
    status:          finalStatus,
    status_code:     statusCode ?? row.status_code,
    webhook_payload: rawPayload,
    updated_at:      new Date().toISOString(),
  };
  if (finalStatus === 'completed') updates.completed_at = new Date().toISOString();
  if (finalStatus === 'failed' && rawPayload?.message) updates.error_message = rawPayload.message;

  const { data: updated } = await supabase
    .from('payout_disbursements')
    .update(updates)
    .eq('id', row.id)
    .select('*')
    .single();

  if (finalStatus === 'completed') {
    // Post matching debit (payout) to the recipient's wallet ledger to keep
    // balance_after consistent. Idempotent on reference_id.
    const { data: existingTx } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('user_id', row.recipient_user_id)
      .eq('reference_id', row.id)
      .eq('transaction_type', 'payout')
      .maybeSingle();

    if (!existingTx) {
      const { data: lastTx } = await supabase
        .from('wallet_transactions')
        .select('balance_after')
        .eq('user_id', row.recipient_user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const prev = Number(lastTx?.balance_after) || 0;
      const debit = Math.round(Number(row.amount) * 100) / 100;
      const newBalance = Math.round((prev - debit) * 100) / 100;
      await supabase.from('wallet_transactions').insert({
        user_id:          row.recipient_user_id,
        user_type:        row.recipient_type,
        transaction_type: 'payout',
        amount:           debit,
        balance_after:    newBalance,
        description:      `Payout to ${row.provider || 'wallet'} (${row.account_number})`,
        reference_id:     row.id,
        status:           'completed',
      });
    }
  }

  return { disbursement: updated };
}
