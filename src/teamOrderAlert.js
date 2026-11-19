/**
 * Texts the DOT team when an order opens to riders (store accepted it, or a
 * rider dropped it back into the pool), so someone can get riders online.
 * Sent by SMS through Twilio, the same account that sends sign-in codes.
 *
 * Off until this is set on the server (Render → Environment):
 *   DOT_ORDER_ALERT_PHONES   DOT's number(s), comma-separated, e.g. "+263771234567"
 * Never throws: an order must not fail because a text did.
 */
import { sendTwilioSms } from './twilioSms.js';

/** "+263 77 123 4567" or "0771234567" → "+263771234567". */
export function alertPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0') && digits.length === 10) return `+263${digits.slice(1)}`;
  return digits.length >= 10 ? `+${digits}` : null;
}

export function teamAlertPhones() {
  return String(process.env.DOT_ORDER_ALERT_PHONES || '')
    .split(',')
    .map(alertPhone)
    .filter(Boolean);
}

async function onlineRiderCount(supabase) {
  try {
    const { count } = await supabase
      .from('couriers')
      .select('id', { count: 'exact', head: true })
      .eq('is_verified', true)
      .eq('verification_status', 'approved')
      .eq('is_online', true);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

export function teamAlertText({ orderNumber, storeName, reopened = false, onlineRiders = null }) {
  const order = orderNumber ? `#${orderNumber}` : '';
  const store = storeName || 'a store';
  const head = reopened
    ? `DOT: order ${order} at ${store} is back open - its rider dropped it.`
    : `DOT: new order ${order} at ${store} needs a rider.`;
  const riders = onlineRiders == null ? '' : ` Riders online: ${onlineRiders}.`;
  return `${head.replace('  ', ' ')}${riders}`;
}

export async function alertDotTeam(supabase, { orderNumber, storeName, reopened = false } = {}) {
  const phones = teamAlertPhones();
  if (!phones.length) return { sent: 0, failed: 0 };
  const onlineRiders = supabase ? await onlineRiderCount(supabase) : null;
  const body = teamAlertText({ orderNumber, storeName, reopened, onlineRiders });
  const result = { sent: 0, failed: 0 };
  await Promise.all(
    phones.map(async (to) => {
      try {
        await sendTwilioSms({ to, body });
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        console.warn('[TeamOrderAlert] SMS failed:', err?.message);
      }
    }),
  );
  console.log('[TeamOrderAlert]', result);
  return result;
}
