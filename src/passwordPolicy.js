import crypto from 'crypto';
import axios from 'axios';

const MIN_PASSWORD_LENGTH = 12;

/** Synchronous length check — cheap, so callers can fail fast before any network call. */
export function checkPasswordLength(password) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { valid: true };
}

/**
 * Checks a password against the HaveIBeenPwned breached-password corpus using
 * the k-anonymity range API — only a 5-character SHA-1 prefix ever leaves
 * this server, never the password or its full hash, so this is safe to call
 * with real user passwords. Fails OPEN (returns false / "not breached") on
 * any network/API error so a HIBP outage never blocks signup or password reset.
 */
export async function isPasswordBreached(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const { data } = await axios.get(`https://api.pwnedpasswords.com/range/${prefix}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'DOT-Delivery-App' },
    });
    const lines = String(data).split('\n');
    for (const line of lines) {
      const [lineSuffix, count] = line.trim().split(':');
      if (lineSuffix === suffix && parseInt(count, 10) > 0) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[PasswordPolicy] HaveIBeenPwned check failed (failing open):', err?.message);
    return false;
  }
}

/** Combined check used at every password-setting entry point (signup, reset). */
export async function assertStrongPassword(password) {
  const lengthCheck = checkPasswordLength(password);
  if (!lengthCheck.valid) return lengthCheck;

  const breached = await isPasswordBreached(password);
  if (breached) {
    return {
      valid: false,
      error: 'This password has appeared in a known data breach. Please choose a different one.',
    };
  }
  return { valid: true };
}
