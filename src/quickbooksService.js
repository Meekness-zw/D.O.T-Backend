import crypto from 'crypto';
import axios from 'axios';
import { supabaseAdmin } from './supabaseAdminClient.js';

const CONNECTION_ID = '11111111-1111-1111-1111-111111111111';

const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
const ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
const REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI;
const STATE_SECRET = process.env.QUICKBOOKS_STATE_SECRET || process.env.SUPABASE_JWT_SECRET;

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API_BASE = ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const MINOR_VERSION = '65';
const SCOPE = 'com.intuit.quickbooks.accounting';

export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI && STATE_SECRET);
}

// ─── Token encryption (AES-256-GCM) ─────────────────────────────────────────
// QUICKBOOKS_TOKEN_ENCRYPTION_KEY must be a 32-byte key, base64 or hex encoded.
function getEncryptionKey() {
  const raw = process.env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('QUICKBOOKS_TOKEN_ENCRYPTION_KEY is not set');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('QUICKBOOKS_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return buf;
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptToken(stored) {
  const key = getEncryptionKey();
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ─── OAuth state token (CSRF protection across the Intuit redirect) ────────
export function createState(dashboardRole) {
  const payload = JSON.stringify({ role: dashboardRole, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const [payloadB64, sig] = state.split('.');
  const expectedSig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  if (sig !== expectedSig) return null;
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (Date.now() - payload.ts > 10 * 60 * 1000) return null; // 10 minute window
  return payload;
}

export function getAuthorizeUrl(dashboardRole) {
  const state = createState(dashboardRole);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ─── Connection persistence ─────────────────────────────────────────────────
async function loadConnectionRow() {
  const { data, error } = await supabaseAdmin
    .from('quickbooks_connections')
    .select('*')
    .eq('id', CONNECTION_ID)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load QuickBooks connection');
  return data;
}

export async function getConnectionStatus() {
  const row = await loadConnectionRow();
  if (!row) return { connected: false };
  return {
    connected: true,
    companyName: row.company_name,
    environment: row.environment,
    realmId: row.realm_id,
    connectedBy: row.connected_by,
    connectedAt: row.created_at,
  };
}

async function saveTokens({ realmId, accessToken, refreshToken, expiresIn, refreshExpiresIn, companyName, connectedBy }) {
  const now = Date.now();
  const row = {
    id: CONNECTION_ID,
    realm_id: realmId,
    environment: ENVIRONMENT,
    access_token: encryptToken(accessToken),
    refresh_token: encryptToken(refreshToken),
    access_token_expires_at: new Date(now + expiresIn * 1000).toISOString(),
    refresh_token_expires_at: new Date(now + refreshExpiresIn * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (companyName !== undefined) row.company_name = companyName;
  if (connectedBy !== undefined) row.connected_by = connectedBy;

  const { error } = await supabaseAdmin.from('quickbooks_connections').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(error.message || 'Failed to save QuickBooks connection');
}

export async function disconnect() {
  const row = await loadConnectionRow();
  if (row) {
    try {
      const refreshToken = decryptToken(row.refresh_token);
      await axios.post(
        REVOKE_URL,
        { token: refreshToken },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          },
        },
      );
    } catch (err) {
      console.warn('[QuickBooks] revoke call failed (continuing with local disconnect):', err.response?.data || err.message);
    }
  }
  const { error } = await supabaseAdmin.from('quickbooks_connections').delete().eq('id', CONNECTION_ID);
  if (error) throw new Error(error.message || 'Failed to remove QuickBooks connection');
}

// ─── OAuth code exchange + token refresh ────────────────────────────────────
export async function handleCallback({ code, realmId, state }) {
  const statePayload = verifyState(state);
  if (!statePayload) {
    throw new Error('Invalid or expired authorization state');
  }

  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
    },
  );

  await saveTokens({
    realmId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.x_refresh_token_expires_in,
    connectedBy: statePayload.role,
  });

  // Fetch company name for display; non-fatal if it fails.
  try {
    const companyInfo = await apiRequest('GET', `companyinfo/${realmId}`);
    const name = companyInfo?.CompanyInfo?.CompanyName;
    if (name) {
      await supabaseAdmin.from('quickbooks_connections').update({ company_name: name }).eq('id', CONNECTION_ID);
    }
  } catch (err) {
    console.warn('[QuickBooks] Failed to fetch company info after connect:', err.message);
  }
}

async function refreshAccessToken(row) {
  const refreshToken = decryptToken(row.refresh_token);
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
    },
  );
  await saveTokens({
    realmId: row.realm_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // Intuit rotates refresh tokens on every use — always persist the new one
    expiresIn: data.expires_in,
    refreshExpiresIn: data.x_refresh_token_expires_in,
  });
  return data.access_token;
}

async function getValidAccessToken() {
  const row = await loadConnectionRow();
  if (!row) throw new Error('QuickBooks is not connected');
  const expiresAt = new Date(row.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > 60 * 1000) {
    return { accessToken: decryptToken(row.access_token), realmId: row.realm_id };
  }
  const accessToken = await refreshAccessToken(row);
  return { accessToken, realmId: row.realm_id };
}

// ─── Generic QuickBooks API request ─────────────────────────────────────────
async function apiRequest(method, path, body) {
  const { accessToken, realmId } = await getValidAccessToken();
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}/v3/company/${realmId}/${path}${separator}minorversion=${MINOR_VERSION}`;
  try {
    const res = await axios({
      method,
      url,
      data: body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    return res.data;
  } catch (err) {
    const qbError = err.response?.data?.Fault?.Error?.[0];
    const message = qbError ? `${qbError.Message}: ${qbError.Detail || ''}` : err.message;
    throw new Error(message);
  }
}

function escapeQbString(value) {
  return String(value).replace(/'/g, "\\'");
}

export async function listAccounts() {
  const data = await apiRequest('GET', `query?query=${encodeURIComponent('SELECT Id, Name, AccountType, Classification FROM Account WHERE Active = true MAXRESULTS 300')}`);
  return (data?.QueryResponse?.Account || []).map((a) => ({
    id: a.Id,
    name: a.Name,
    accountType: a.AccountType,
    classification: a.Classification,
  }));
}

export async function listItems() {
  const data = await apiRequest('GET', `query?query=${encodeURIComponent('SELECT Id, Name, Type FROM Item WHERE Active = true MAXRESULTS 300')}`);
  return (data?.QueryResponse?.Item || []).map((i) => ({ id: i.Id, name: i.Name, type: i.Type }));
}

export async function listCustomers(search) {
  const base = 'SELECT Id, DisplayName FROM Customer WHERE Active = true';
  const query = search ? `${base} AND DisplayName LIKE '%${escapeQbString(search)}%'` : base;
  const data = await apiRequest('GET', `query?query=${encodeURIComponent(`${query} MAXRESULTS 50`)}`);
  return (data?.QueryResponse?.Customer || []).map((c) => ({ id: c.Id, name: c.DisplayName }));
}

export async function createDefaultCustomer(displayName) {
  const data = await apiRequest('POST', 'customer', { DisplayName: displayName });
  return { id: data.Customer.Id, name: data.Customer.DisplayName };
}

// ─── Mappings ────────────────────────────────────────────────────────────
const MAPPING_KEYS = [
  'sales_item',
  'delivery_item',
  'tax_item',
  'default_customer',
  'merchant_payout_account',
  'courier_payout_account',
  'payout_bank_account',
];

export async function getMappings() {
  const { data, error } = await supabaseAdmin.from('quickbooks_mappings').select('mapping_key, qb_id, qb_name');
  if (error) throw new Error(error.message || 'Failed to load mappings');
  const byKey = Object.fromEntries((data || []).map((m) => [m.mapping_key, { id: m.qb_id, name: m.qb_name }]));
  return MAPPING_KEYS.reduce((acc, key) => {
    acc[key] = byKey[key] || null;
    return acc;
  }, {});
}

export async function saveMappings(mappings) {
  const rows = Object.entries(mappings || {})
    .filter(([key, val]) => MAPPING_KEYS.includes(key) && val && val.id)
    .map(([key, val]) => ({
      mapping_key: key,
      qb_id: String(val.id),
      qb_name: val.name || null,
      updated_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from('quickbooks_mappings').upsert(rows, { onConflict: 'mapping_key' });
  if (error) throw new Error(error.message || 'Failed to save mappings');
}

// ─── Sync log helpers (idempotency) ─────────────────────────────────────────
async function alreadySynced(entityType, entityId) {
  const { data } = await supabaseAdmin
    .from('quickbooks_sync_log')
    .select('status')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .maybeSingle();
  return data?.status === 'synced';
}

async function recordSyncResult(entityType, entityId, result) {
  const row = {
    entity_type: entityType,
    entity_id: entityId,
    qb_object_type: result.qbObjectType || null,
    qb_object_id: result.qbObjectId || null,
    status: result.status,
    error_message: result.errorMessage || null,
    synced_at: new Date().toISOString(),
  };
  await supabaseAdmin.from('quickbooks_sync_log').upsert(row, { onConflict: 'entity_type,entity_id' });
}

export async function getSyncLog({ limit = 50 } = {}) {
  const { data, error } = await supabaseAdmin
    .from('quickbooks_sync_log')
    .select('*')
    .order('synced_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message || 'Failed to load sync log');
  return data || [];
}

// ─── Order → Sales Receipt ──────────────────────────────────────────────────
export async function syncOrder(order) {
  if (await alreadySynced('order', order.id)) return { skipped: true };
  try {
    const mappings = await getMappings();
    if (!mappings.sales_item || !mappings.default_customer) {
      throw new Error('QuickBooks mappings incomplete: set a Sales item and Default customer before syncing orders');
    }

    const lines = [
      {
        Amount: Number(order.subtotal),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: mappings.sales_item.id } },
      },
    ];
    const deliveryFee = Number(order.customer_delivery_fee ?? order.delivery_fee ?? 0);
    if (deliveryFee > 0 && mappings.delivery_item) {
      lines.push({
        Amount: deliveryFee,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: mappings.delivery_item.id } },
      });
    }
    const tax = Number(order.tax || 0);
    if (tax > 0 && mappings.tax_item) {
      lines.push({
        Amount: tax,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: mappings.tax_item.id } },
      });
    }

    const payload = {
      CustomerRef: { value: mappings.default_customer.id },
      TxnDate: (order.created_at || new Date().toISOString()).slice(0, 10),
      DocNumber: order.order_number,
      PrivateNote: `Delivery On Time order ${order.order_number}`,
      Line: lines,
    };

    const data = await apiRequest('POST', 'salesreceipt', payload);
    const qbId = data?.SalesReceipt?.Id;
    await recordSyncResult('order', order.id, { status: 'synced', qbObjectType: 'SalesReceipt', qbObjectId: qbId });
    return { synced: true, qbObjectId: qbId };
  } catch (err) {
    await recordSyncResult('order', order.id, { status: 'failed', errorMessage: err.message });
    console.error(`[QuickBooks] Failed to sync order ${order.id}:`, err.message);
    return { synced: false, error: err.message };
  }
}

// ─── Withdrawal (payout) → Expense ─────────────────────────────────────────
export async function syncWithdrawal(withdrawal) {
  if (await alreadySynced('withdrawal', withdrawal.id)) return { skipped: true };
  try {
    const mappings = await getMappings();
    const expenseAccountKey = withdrawal.role === 'courier' ? 'courier_payout_account' : 'merchant_payout_account';
    const expenseAccount = mappings[expenseAccountKey];
    if (!expenseAccount || !mappings.payout_bank_account) {
      throw new Error(`QuickBooks mappings incomplete: set a ${withdrawal.role} payout expense account and a payout bank account before syncing withdrawals`);
    }

    const payload = {
      PaymentType: 'Cash',
      AccountRef: { value: mappings.payout_bank_account.id },
      TxnDate: (withdrawal.processed_at || withdrawal.created_at || new Date().toISOString()).slice(0, 10),
      PrivateNote: `Withdrawal payout — ${withdrawal.role} ${withdrawal.user_id}`,
      Line: [
        {
          Amount: Number(withdrawal.amount),
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccount.id } },
        },
      ],
    };

    const data = await apiRequest('POST', 'purchase', payload);
    const qbId = data?.Purchase?.Id;
    await recordSyncResult('withdrawal', withdrawal.id, { status: 'synced', qbObjectType: 'Purchase', qbObjectId: qbId });
    return { synced: true, qbObjectId: qbId };
  } catch (err) {
    await recordSyncResult('withdrawal', withdrawal.id, { status: 'failed', errorMessage: err.message });
    console.error(`[QuickBooks] Failed to sync withdrawal ${withdrawal.id}:`, err.message);
    return { synced: false, error: err.message };
  }
}

// ─── Backfill: sweep recent paid orders + paid withdrawals that aren't synced yet ──
export async function backfillSync({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders, error: ordersError } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, subtotal, delivery_fee, customer_delivery_fee, tax, total_amount, created_at')
    .eq('payment_status', 'paid')
    .gte('created_at', since)
    .limit(200);
  if (ordersError) throw new Error(ordersError.message || 'Failed to load orders for backfill');

  const { data: withdrawals, error: withdrawalsError } = await supabaseAdmin
    .from('withdrawal_requests')
    .select('id, user_id, role, amount, processed_at, created_at')
    .eq('status', 'paid')
    .gte('created_at', since)
    .limit(200);
  if (withdrawalsError) throw new Error(withdrawalsError.message || 'Failed to load withdrawals for backfill');

  let ordersSynced = 0;
  let ordersFailed = 0;
  for (const order of orders || []) {
    const result = await syncOrder(order);
    if (result.synced) ordersSynced++;
    else if (!result.skipped) ordersFailed++;
  }

  let withdrawalsSynced = 0;
  let withdrawalsFailed = 0;
  for (const withdrawal of withdrawals || []) {
    const result = await syncWithdrawal(withdrawal);
    if (result.synced) withdrawalsSynced++;
    else if (!result.skipped) withdrawalsFailed++;
  }

  return { ordersSynced, ordersFailed, withdrawalsSynced, withdrawalsFailed };
}
