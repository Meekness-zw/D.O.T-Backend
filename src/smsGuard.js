/**
 * Spend guard for outbound SMS.
 *
 * The per-IP-plus-phone rate limiter in server.js cannot bound cost: its key
 * includes the number, so every new number an attacker tries starts with a
 * fresh allowance. Unlimited numbers means unlimited spend, and the in-memory
 * counters reset on every deploy.
 *
 * The caps here are counted from sms_send_log, so they survive restarts, and
 * they are layered deliberately:
 *
 *   per phone   — a real person needs one or two codes, never a dozen
 *   per IP      — one address should not be texting the world
 *   fan-out     — one address hitting many distinct numbers is the actual
 *                 signature of pumping, and nothing legitimate looks like it
 *   global      — a hard daily ceiling, so that however novel the abuse is,
 *                 the bill stops at a number chosen in advance
 *
 * Every limit is env-tunable, because the right ceiling depends on real signup
 * volume and should be raised deliberately rather than by editing code.
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function envInt(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const SMS_LIMITS = {
  perPhonePerHour: () => envInt('SMS_MAX_PER_PHONE_HOUR', 3),
  perPhonePerDay: () => envInt('SMS_MAX_PER_PHONE_DAY', 8),
  perIpPerHour: () => envInt('SMS_MAX_PER_IP_HOUR', 10),
  perIpPerDay: () => envInt('SMS_MAX_PER_IP_DAY', 30),
  distinctPhonesPerIpPerDay: () => envInt('SMS_MAX_PHONES_PER_IP_DAY', 12),
  globalPerDay: () => envInt('SMS_MAX_GLOBAL_DAY', 400),
};

/**
 * Country allowlist, as comma-separated dialling prefixes, e.g. "+263,+27".
 *
 * This is the single biggest lever on cost. Pumping is only profitable on
 * expensive international ranges, so a service that delivers to one country
 * has little reason to accept numbers from anywhere else. Unset means allow
 * everything, which keeps existing behaviour for anyone who has not chosen.
 */
function allowedPrefixes() {
  const raw = String(process.env.SMS_ALLOWED_COUNTRY_PREFIXES || '').trim();
  if (!raw) return null;
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

async function countSince(column, value, since) {
  let query = supabase
    .from('sms_send_log')
    .select('id', { count: 'exact', head: true })
    .is('blocked_reason', null)
    .gte('created_at', new Date(Date.now() - since).toISOString());
  if (column) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(error.message || 'Failed to count SMS sends');
  return count || 0;
}

async function distinctPhonesForIp(ip, since) {
  const { data, error } = await supabase
    .from('sms_send_log')
    .select('phone')
    .eq('ip', ip)
    .is('blocked_reason', null)
    .gte('created_at', new Date(Date.now() - since).toISOString());
  if (error) throw new Error(error.message || 'Failed to count SMS recipients');
  return new Set((data || []).map((r) => r.phone)).size;
}

export async function recordSmsAttempt({ phone, ip, purpose, blockedReason = null }) {
  if (!supabase) return;
  try {
    await supabase.from('sms_send_log').insert({
      phone: String(phone || ''),
      ip: ip || null,
      purpose,
      blocked_reason: blockedReason,
    });
  } catch (err) {
    console.error('[smsGuard] failed to log SMS attempt:', err?.message || err);
  }
}

/**
 * Decides whether one SMS may be sent.
 *
 * Returns { allowed: true } or { allowed: false, reason, message } where
 * `message` is safe to show a customer — it never reveals which cap was hit,
 * since that would tell an attacker exactly what to rotate next.
 */
export async function checkSmsAllowed({ phone, ip, purpose }) {
  const generic = 'Too many verification codes have been requested. Please try again later.';
  const number = String(phone || '').trim();
  if (!number) return { allowed: false, reason: 'no_phone', message: 'A phone number is required.' };

  const prefixes = allowedPrefixes();
  if (prefixes && !prefixes.some((p) => number.startsWith(p))) {
    return {
      allowed: false,
      reason: 'country_not_allowed',
      message: 'We cannot send verification codes to that country yet.',
    };
  }

  if (!supabase) return { allowed: true };

  try {
    // Cheapest and most specific checks first, so an ordinary repeat request
    // is refused without running the wider aggregate queries.
    const [phoneHour, phoneDay] = await Promise.all([
      countSince('phone', number, HOUR),
      countSince('phone', number, DAY),
    ]);
    if (phoneHour >= SMS_LIMITS.perPhonePerHour()) return { allowed: false, reason: 'phone_hour', message: generic };
    if (phoneDay >= SMS_LIMITS.perPhonePerDay()) return { allowed: false, reason: 'phone_day', message: generic };

    if (ip) {
      const [ipHour, ipDay, fanOut] = await Promise.all([
        countSince('ip', ip, HOUR),
        countSince('ip', ip, DAY),
        distinctPhonesForIp(ip, DAY),
      ]);
      if (ipHour >= SMS_LIMITS.perIpPerHour()) return { allowed: false, reason: 'ip_hour', message: generic };
      if (ipDay >= SMS_LIMITS.perIpPerDay()) return { allowed: false, reason: 'ip_day', message: generic };
      if (fanOut >= SMS_LIMITS.distinctPhonesPerIpPerDay()) {
        return { allowed: false, reason: 'ip_fanout', message: generic };
      }
    }

    const globalDay = await countSince(null, null, DAY);
    if (globalDay >= SMS_LIMITS.globalPerDay()) {
      // Loud, because this one means the other layers were bypassed and the
      // service is now refusing real signups.
      console.error(`[smsGuard] GLOBAL DAILY SMS CAP REACHED (${globalDay}). No further SMS will send for 24h.`);
      return { allowed: false, reason: 'global_day', message: generic };
    }

    return { allowed: true };
  } catch (err) {
    // Fail CLOSED. An unreachable counter must not become an open tap; the
    // whole point of this module is that nothing unbounded reaches Dexatel.
    console.error('[smsGuard] check failed, refusing to send:', err?.message || err);
    return { allowed: false, reason: 'check_failed', message: generic };
  }
}

/** Convenience wrapper: check, log the outcome, and report back. */
export async function guardSms({ phone, ip, purpose }) {
  const verdict = await checkSmsAllowed({ phone, ip, purpose });
  await recordSmsAttempt({ phone, ip, purpose, blockedReason: verdict.allowed ? null : verdict.reason });
  if (!verdict.allowed) {
    console.warn(`[smsGuard] blocked ${purpose} to ${String(phone).slice(0, 6)}… — ${verdict.reason}`);
  }
  return verdict;
}
