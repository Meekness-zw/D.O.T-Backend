import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const BCRYPT_ROUNDS = 10;

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$/.test(hash);
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

/** Hash a new/changed password. Always bcrypt going forward. */
export function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

/**
 * Verifies a password against a stored hash. Transparently supports the
 * legacy unsalted SHA-256 hashes written before bcrypt was introduced — on
 * a successful legacy match, `needsRehash` is true so the caller can
 * upgrade the stored hash to bcrypt on this same login, with no forced
 * password reset for existing users.
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash) return { valid: false, needsRehash: false };
  if (isBcryptHash(storedHash)) {
    return { valid: bcrypt.compareSync(String(password), storedHash), needsRehash: false };
  }
  const legacy = Buffer.from(legacySha256(password), 'utf8');
  const stored = Buffer.from(String(storedHash), 'utf8');
  const valid = legacy.length === stored.length && crypto.timingSafeEqual(legacy, stored);
  return { valid, needsRehash: valid };
}
