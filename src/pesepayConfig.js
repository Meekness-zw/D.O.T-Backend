/**
 * Pesepay configuration – central place to read and validate
 * integration & encryption keys from the environment.
 *
 * NOTE: These are TEST keys right now. For production, swap the values
 * in backend/.env and restart the server.
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

