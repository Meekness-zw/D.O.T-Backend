/**
 * Pesepay configuration – central place to read and validate
 * integration & encryption keys from the environment.
 *
 * Credentials must match PESEPAY_ENV: sandbox credentials use the sandbox
 * host; live credentials use the production host.
 */

const {
  PAYMENT_INTEGRATION_ID,
  PAYMENT_ENCRYPTION_KEY,
} = process.env;

if (!PAYMENT_INTEGRATION_ID || !PAYMENT_ENCRYPTION_KEY) {
  console.warn(
    '[Pesepay] PAYMENT_INTEGRATION_ID or PAYMENT_ENCRYPTION_KEY is missing. ' +
      'Payment operations will not work until these are set in backend/.env.',
  );
}

export function getPesepayConfig() {
  return {
    integrationKey: PAYMENT_INTEGRATION_ID,
    encryptionKey: PAYMENT_ENCRYPTION_KEY,
  };
}

export function getPesepayEnvironment() {
  const explicitBase = String(process.env.PESEPAY_BASE_URL || '').trim();
  const sandbox = String(process.env.PESEPAY_ENV || '').trim().toLowerCase() === 'sandbox';
  return {
    name: sandbox ? 'sandbox' : 'production',
    baseUrl: explicitBase || (sandbox
      ? 'https://api.test.sandbox.pesepay.com/payments-engine/'
      : 'https://api.pesepay.com/api/payments-engine/'),
  };
}
