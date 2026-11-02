import crypto from 'crypto';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { hashPassword, verifyPassword } from './passwordHash.js';

/**
 * Sign-in with a 4-digit PIN instead of a password.
 *
 * Four digits are only 10,000 combinations, so a PIN is never enough on its
 * own from an unknown phone or browser:
 * - A trusted device (one that has proven itself with an emailed code) signs
 *   in with phone + PIN. It holds a 'device' token; the server keeps its hash.
 * - Any other device must enter an emailed code first, and only then the PIN.
 *   So nobody can try PINs from their own phone without the account's email.
 * - Five wrong PINs lock the PIN until it is reset with an emailed code.
 * - Face ID / fingerprint: the phone keeps a separate 'biometric' token behind
 *   its own biometric check, and that token alone signs in.
 */

export const PIN_MAX_ATTEMPTS = 5;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
// A locked PIN stays locked until it is reset with an emailed code.
const LOCKED_UNTIL = '2999-01-01T00:00:00Z';

/** Null if the PIN is acceptable, otherwise why not. */
export function pinProblem(pin) {
  const value = String(pin ?? '');
  if (!/^\d{4}$/.test(value)) return 'Your PIN must be exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(value)) return 'Choose a PIN that isn’t the same digit four times.';
  const ascending = '0123456789';
  const descending = '9876543210';
  if (ascending.includes(value) || descending.includes(value)) {
    return 'Choose a PIN that isn’t a simple sequence like 1234.';
  }
  return null;
}

export function hashPin(pin) {
  return hashPassword(String(pin));
}

export function isPinLocked(profile, now = Date.now()) {
  return !!profile?.pin_locked_until && new Date(profile.pin_locked_until).getTime() > now;
}

/**
 * Check a PIN against an account, counting failures.
 * Returns { ok: true } | { ok: false, locked: true } | { ok: false, attemptsLeft }.
 */
export async function checkAccountPin(profile, pin) {
  if (isPinLocked(profile)) return { ok: false, locked: true };
  if (verifyPassword(String(pin ?? ''), profile.pin_hash).valid) {
    if (profile.pin_failed_attempts) {
      await supabaseAdmin
        .from('user_profiles')
        .update({ pin_failed_attempts: 0 })
        .eq('id', profile.id);
    }
    return { ok: true };
  }
  const failed = (profile.pin_failed_attempts || 0) + 1;
  const locked = failed >= PIN_MAX_ATTEMPTS;
  await supabaseAdmin
    .from('user_profiles')
    .update({ pin_failed_attempts: failed, pin_locked_until: locked ? LOCKED_UNTIL : null })
    .eq('id', profile.id);
  return locked ? { ok: false, locked: true } : { ok: false, attemptsLeft: PIN_MAX_ATTEMPTS - failed };
}

/** Set (or replace) an account's PIN and unlock it. */
export async function setAccountPin(userId, pin) {
  const { error } = await supabaseAdmin
    .from('user_profiles')
    .update({ pin_hash: hashPin(pin), pin_failed_attempts: 0, pin_locked_until: null })
    .eq('id', userId);
  if (error) throw error;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A new token for this device. Only its hash is stored. */
export async function issueDeviceToken(userId, kind = 'device') {
  const token = crypto.randomBytes(32).toString('base64url');
  const { error } = await supabaseAdmin
    .from('trusted_devices')
    .insert({ user_id: userId, token_hash: tokenHash(token), kind });
  if (error) throw error;
  return token;
}

/** The user id a device token belongs to, or null. */
export async function userForDeviceToken(token, kind = 'device') {
  if (!token || typeof token !== 'string') return null;
  const { data } = await supabaseAdmin
    .from('trusted_devices')
    .select('id, user_id')
    .eq('token_hash', tokenHash(token))
    .eq('kind', kind)
    .maybeSingle();
  if (!data) return null;
  supabaseAdmin
    .from('trusted_devices')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {});
  return data.user_id;
}

export async function revokeDeviceToken(token) {
  if (!token) return;
  await supabaseAdmin.from('trusted_devices').delete().eq('token_hash', tokenHash(token));
}

/** Forget every trusted device of an account (after a PIN reset). */
export async function revokeAllDeviceTokens(userId) {
  await supabaseAdmin.from('trusted_devices').delete().eq('user_id', userId);
}

// Emailed codes for new devices and PIN resets, keyed by user id. In memory,
// like the other one-time codes: a restart just means asking for a new code.
const codeStore = new Map();

export function createEmailCode(userId, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  codeStore.set(userId, { code, purpose, expiresAt: Date.now() + CODE_TTL_MS, failedAttempts: 0 });
  return code;
}

/**
 * Check an emailed code without using it up (the PIN step may still fail).
 * Returns { ok: true } or { ok: false, status, error }.
 */
export function checkEmailCode(userId, purpose, code) {
  const entry = codeStore.get(userId);
  if (!entry || entry.purpose !== purpose) {
    return { ok: false, status: 400, error: 'No code found. Please request a new one.' };
  }
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(userId);
    return { ok: false, status: 400, error: 'That code has expired. Please request a new one.' };
  }
  if (entry.code !== String(code ?? '').trim()) {
    entry.failedAttempts += 1;
    if (entry.failedAttempts >= CODE_MAX_ATTEMPTS) {
      codeStore.delete(userId);
      return { ok: false, status: 429, error: 'Too many incorrect codes. Please request a new one.' };
    }
    return { ok: false, status: 400, error: 'Incorrect code.' };
  }
  return { ok: true };
}

export function consumeEmailCode(userId) {
  codeStore.delete(userId);
}

export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return 'your email';
  return `${local.slice(0, 1)}***@${domain}`;
}
