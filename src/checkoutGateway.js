import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OVERRIDE_PATH = path.join(__dirname, '..', 'data', 'checkout-gateway.json');

export const CHECKOUT_GATEWAYS = {
  pesepay: {
    id: 'pesepay',
    label: 'Pay with card',
    subtitle: 'Debit or credit card',
  },
  smilepay: {
    id: 'smilepay',
    label: 'Pay with card',
    subtitle: 'Debit or credit card',
  },
};

function overridePath() {
  return process.env.CHECKOUT_GATEWAY_FILE || DEFAULT_OVERRIDE_PATH;
}

export function normalizeCheckoutGateway(value) {
  const id = String(value || '').trim().toLowerCase();
  return CHECKOUT_GATEWAYS[id] ? id : null;
}

export function isOnlineCheckoutMethod(method) {
  return normalizeCheckoutGateway(method) != null;
}

export const DEFAULT_CHECKOUT_GATEWAY = 'smilepay';
export const BACKUP_CHECKOUT_GATEWAY = 'pesepay';

export function backupFor(gateway) {
  return gateway === 'smilepay' ? 'pesepay' : 'smilepay';
}

/**
 * Preferred gate for customer charges and payouts. ZB Smile Cash is the
 * default. A file written by the admin endpoint wins over
 * CHECKOUT_PAYMENT_GATEWAY so the IT team can flip the preferred gate
 * without restarting the API and without shipping a new app build.
 * Pesepay is the backup when the preferred gate is not configured or its
 * call fails.
 */
export function getActiveCheckoutGateway() {
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath(), 'utf8'));
    const fromFile = normalizeCheckoutGateway(raw?.gateway);
    if (fromFile) return fromFile;
  } catch {
    // Missing file is the normal case; fall through to env.
  }
  return normalizeCheckoutGateway(process.env.CHECKOUT_PAYMENT_GATEWAY) || DEFAULT_CHECKOUT_GATEWAY;
}

/**
 * Gate the app should open right now. Prefer ZB Smile Cash. Use Pesepay
 * when Smile Cash has no keys, or the other way around if the preferred
 * gate was switched and that one is not configured.
 */
export function resolveCheckoutGateway({ smileConfigured = false, pesepayConfigured = false } = {}) {
  const preferred = getActiveCheckoutGateway();
  const backup = backupFor(preferred);
  const ready = (id) => (id === 'smilepay' ? smileConfigured : pesepayConfigured);
  if (ready(preferred)) {
    return { gateway: preferred, preferred, backup, usingBackup: false };
  }
  if (ready(backup)) {
    return { gateway: backup, preferred, backup, usingBackup: true };
  }
  return { gateway: preferred, preferred, backup, usingBackup: false };
}

export function setActiveCheckoutGateway(gateway) {
  const id = normalizeCheckoutGateway(gateway);
  if (!id) {
    throw new Error('gateway must be pesepay or smilepay');
  }
  const file = overridePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ gateway: id, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return id;
}

export function describeCheckoutGateway(id = getActiveCheckoutGateway()) {
  return CHECKOUT_GATEWAYS[id] || CHECKOUT_GATEWAYS.pesepay;
}
