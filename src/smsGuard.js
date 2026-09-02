/**
 * Spend guard for outbound SMS.
 *
 * Successful provider submissions are counted in Supabase so limits survive
 * restarts. A small in-memory mirror keeps the same limits active when the
 * counter table/database is temporarily unavailable; an infrastructure error
 * must never be reported to a customer as a real rate-limit violation.
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DATABASE_RETRY_DELAY = 60 * 1000;
const PENDING_SEND_TTL = 2 * 60 * 1000;

function envInt(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Per-IP limits exist to slow down a single attacker script, not to cap real
// users — but mobile carriers (this app's actual usage pattern in Zimbabwe)
// commonly put thousands of distinct customers behind one shared
// carrier-grade-NAT IP. The old defaults (10/hour, 30/day, 12 distinct
// phones/day) were blocking real signups after a handful of unrelated
// people happened to sign up from the same carrier IP the same day. Raised
// well above anything one legitimate shared IP would realistically produce;
// per-phone and global-per-day limits (unchanged) remain the real abuse guard.
export const SMS_LIMITS = {
  perPhonePerHour: () => envInt('SMS_MAX_PER_PHONE_HOUR', 3),
  perPhonePerDay: () => envInt('SMS_MAX_PER_PHONE_DAY', 8),
  perIpPerHour: () => envInt('SMS_MAX_PER_IP_HOUR', 60),
  perIpPerDay: () => envInt('SMS_MAX_PER_IP_DAY', 300),
  distinctPhonesPerIpPerDay: () => envInt('SMS_MAX_PHONES_PER_IP_DAY', 150),
  globalPerDay: () => envInt('SMS_MAX_GLOBAL_DAY', 400),
  fallbackGlobalPerDay: () => envInt('SMS_MAX_FALLBACK_GLOBAL_DAY', 50),
};

/** Country allowlist as comma-separated dialling prefixes, e.g. "+263,+27". */
function allowedPrefixes() {
  const raw = String(process.env.SMS_ALLOWED_COUNTRY_PREFIXES || '').trim();
  if (!raw) return null;
  return raw.split(',').map((prefix) => prefix.trim()).filter(Boolean);
}

/**
 * Create an isolated guard. The optional dependencies keep the production
 * implementation testable without contacting Supabase.
 */
export function createSmsGuard({ client = supabase, clock = () => Date.now(), logger = console } = {}) {
  const successfulSends = [];
  let databaseRetryAt = 0;
  let reservationSequence = 0;

  const generic = 'Too many verification codes have been requested. Please try again later.';

  function pruneLocal(now) {
    const oldestAllowed = now - DAY;
    const oldestPending = now - PENDING_SEND_TTL;
    for (let index = successfulSends.length - 1; index >= 0; index -= 1) {
      const entry = successfulSends[index];
      if (entry.createdAt < oldestAllowed || (entry.status === 'pending' && entry.createdAt < oldestPending)) {
        successfulSends.splice(index, 1);
      }
    }
  }

  function localVerdict(number, ip, now, globalLimit = SMS_LIMITS.globalPerDay()) {
    pruneLocal(now);
    const hourStart = now - HOUR;
    const phoneSends = successfulSends.filter((entry) => entry.phone === number);
    if (phoneSends.filter((entry) => entry.createdAt >= hourStart).length >= SMS_LIMITS.perPhonePerHour()) {
      return { allowed: false, reason: 'phone_hour', message: generic };
    }
    if (phoneSends.length >= SMS_LIMITS.perPhonePerDay()) {
      return { allowed: false, reason: 'phone_day', message: generic };
    }

    if (ip) {
      const ipSends = successfulSends.filter((entry) => entry.ip === ip);
      if (ipSends.filter((entry) => entry.createdAt >= hourStart).length >= SMS_LIMITS.perIpPerHour()) {
        return { allowed: false, reason: 'ip_hour', message: generic };
      }
      if (ipSends.length >= SMS_LIMITS.perIpPerDay()) {
        return { allowed: false, reason: 'ip_day', message: generic };
      }
      const phones = new Set(ipSends.map((entry) => entry.phone));
      if (!phones.has(number) && phones.size >= SMS_LIMITS.distinctPhonesPerIpPerDay()) {
        return { allowed: false, reason: 'ip_fanout', message: generic };
      }
    }

    if (successfulSends.length >= globalLimit) {
      logger.error(`[smsGuard] LOCAL GLOBAL DAILY SMS CAP REACHED (${successfulSends.length}).`);
      return { allowed: false, reason: 'global_day', message: generic };
    }
    return { allowed: true };
  }

  async function countSince(column, value, since, now) {
    let query = client
      .from('sms_send_log')
      .select('id', { count: 'exact', head: true })
      .is('blocked_reason', null)
      .gte('created_at', new Date(now - since).toISOString())
      .lte('created_at', new Date(now).toISOString());
    if (column) query = query.eq(column, value);
    const { count, error } = await query;
    if (error) throw new Error(error.message || 'Failed to count SMS sends');
    return count || 0;
  }

  async function phonesForIp(ip, since, now) {
    const { data, error } = await client
      .from('sms_send_log')
      .select('phone')
      .eq('ip', ip)
      .is('blocked_reason', null)
      .gte('created_at', new Date(now - since).toISOString())
      .lte('created_at', new Date(now).toISOString());
    if (error) throw new Error(error.message || 'Failed to count SMS recipients');
    return new Set((data || []).map((row) => row.phone));
  }

  function markDatabaseUnavailable(error, now) {
    if (now >= databaseRetryAt) {
      logger.error('[smsGuard] durable counter unavailable; using local safety limits:', error?.message || error);
    }
    databaseRetryAt = now + DATABASE_RETRY_DELAY;
  }

  function degradedVerdict(number, ip, now) {
    const verdict = localVerdict(number, ip, now, SMS_LIMITS.fallbackGlobalPerDay());
    return verdict.allowed ? { ...verdict, degraded: true } : verdict;
  }

  async function checkSmsAllowed({ phone, ip }) {
    const number = String(phone || '').trim();
    if (!number) return { allowed: false, reason: 'no_phone', message: 'A phone number is required.' };

    const prefixes = allowedPrefixes();
    if (prefixes && !prefixes.some((prefix) => number.startsWith(prefix))) {
      return {
        allowed: false,
        reason: 'country_not_allowed',
        message: 'We cannot send verification codes to that country yet.',
      };
    }

    const now = clock();
    const fallbackVerdict = localVerdict(number, ip, now);
    if (!fallbackVerdict.allowed) return fallbackVerdict;
    if (!client || now < databaseRetryAt) return degradedVerdict(number, ip, now);

    try {
      const [phoneHour, phoneDay] = await Promise.all([
        countSince('phone', number, HOUR, now),
        countSince('phone', number, DAY, now),
      ]);
      if (phoneHour >= SMS_LIMITS.perPhonePerHour()) return { allowed: false, reason: 'phone_hour', message: generic };
      if (phoneDay >= SMS_LIMITS.perPhonePerDay()) return { allowed: false, reason: 'phone_day', message: generic };

      if (ip) {
        const [ipHour, ipDay, phones] = await Promise.all([
          countSince('ip', ip, HOUR, now),
          countSince('ip', ip, DAY, now),
          phonesForIp(ip, DAY, now),
        ]);
        if (ipHour >= SMS_LIMITS.perIpPerHour()) return { allowed: false, reason: 'ip_hour', message: generic };
        if (ipDay >= SMS_LIMITS.perIpPerDay()) return { allowed: false, reason: 'ip_day', message: generic };
        if (!phones.has(number) && phones.size >= SMS_LIMITS.distinctPhonesPerIpPerDay()) {
          return { allowed: false, reason: 'ip_fanout', message: generic };
        }
      }

      const globalDay = await countSince(null, null, DAY, now);
      if (globalDay >= SMS_LIMITS.globalPerDay()) {
        logger.error(`[smsGuard] GLOBAL DAILY SMS CAP REACHED (${globalDay}). No further SMS will send for 24h.`);
        return { allowed: false, reason: 'global_day', message: generic };
      }
      return { allowed: true };
    } catch (error) {
      // The route still has an IP+phone limiter, and localVerdict enforces all
      // spend caps for this process. This keeps signup available when the
      // durable table is missing or Supabase has a transient outage.
      markDatabaseUnavailable(error, now);
      return degradedVerdict(number, ip, now);
    }
  }

  async function recordSmsAttempt({ phone, ip, purpose, blockedReason = null }) {
    if (!client || clock() < databaseRetryAt) return;
    try {
      const { error } = await client.from('sms_send_log').insert({
        phone: String(phone || ''),
        ip: ip || null,
        purpose,
        blocked_reason: blockedReason,
      });
      if (error) throw new Error(error.message || 'Failed to log SMS attempt');
    } catch (error) {
      markDatabaseUnavailable(error, clock());
    }
  }

  function findReservation({ reservationId, phone, ip, purpose }) {
    if (reservationId) {
      return successfulSends.find((entry) => entry.id === reservationId && entry.status === 'pending');
    }
    return successfulSends.find((entry) => (
      entry.status === 'pending'
      && entry.phone === String(phone || '')
      && entry.ip === (ip || null)
      && entry.purpose === purpose
    ));
  }

  async function recordSmsSent({ phone, ip, purpose, reservationId }) {
    const reservation = findReservation({ reservationId, phone, ip, purpose });
    if (reservation) {
      reservation.status = 'sent';
      reservation.createdAt = clock();
    } else {
      successfulSends.push({
        phone: String(phone || ''),
        ip: ip || null,
        purpose,
        createdAt: clock(),
        status: 'sent',
      });
    }
    await recordSmsAttempt({ phone, ip, purpose, blockedReason: null });
  }

  async function recordSmsFailure({ phone, ip, purpose, reservationId, reason = 'provider_failed' }) {
    const reservation = findReservation({ reservationId, phone, ip, purpose });
    if (reservation) successfulSends.splice(successfulSends.indexOf(reservation), 1);
    await recordSmsAttempt({ phone, ip, purpose, blockedReason: reason });
  }

  async function guardSms({ phone, ip, purpose }) {
    let verdict = await checkSmsAllowed({ phone, ip, purpose });

    // Recheck immediately before reserving. Concurrent requests can all await
    // the same database snapshot; this synchronous check makes each pending
    // provider call visible to the next continuation in this process.
    if (verdict.allowed) {
      const localLimit = verdict.degraded ? SMS_LIMITS.fallbackGlobalPerDay() : SMS_LIMITS.globalPerDay();
      const reservationVerdict = localVerdict(String(phone || '').trim(), ip, clock(), localLimit);
      if (!reservationVerdict.allowed) verdict = reservationVerdict;
    }

    if (!verdict.allowed) {
      await recordSmsAttempt({ phone, ip, purpose, blockedReason: verdict.reason });
      logger.warn(`[smsGuard] blocked ${purpose} to ${String(phone).slice(0, 6)}… — ${verdict.reason}`);
      return verdict;
    }
    const reservationId = `${clock()}-${reservationSequence += 1}`;
    successfulSends.push({
      id: reservationId,
      phone: String(phone || ''),
      ip: ip || null,
      purpose,
      createdAt: clock(),
      status: 'pending',
    });
    return { ...verdict, reservationId };
  }

  return { checkSmsAllowed, guardSms, recordSmsAttempt, recordSmsSent, recordSmsFailure };
}

const defaultGuard = createSmsGuard();

export const checkSmsAllowed = defaultGuard.checkSmsAllowed;
export const guardSms = defaultGuard.guardSms;
export const recordSmsAttempt = defaultGuard.recordSmsAttempt;
export const recordSmsSent = defaultGuard.recordSmsSent;
export const recordSmsFailure = defaultGuard.recordSmsFailure;
