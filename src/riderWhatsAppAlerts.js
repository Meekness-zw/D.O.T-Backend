/**
 * "New order — go online" WhatsApp alerts for riders who are offline.
 *
 * When a store accepts an order (the job opens to couriers), every approved
 * rider who is NOT online gets a WhatsApp message through Infobip, so they
 * open the app and go online. Riders who are online already get the push
 * notification instead.
 *
 * Off until these are set on the server (Render → Environment):
 *   INFOBIP_API_KEY, INFOBIP_BASE_URL   (already used for WhatsApp)
 *   INFOBIP_WHATSAPP_FROM               DOT's own WhatsApp sender number
 *   INFOBIP_RIDER_ALERT_TEMPLATE        approved template name, body e.g.
 *     "New DOT order at {{1}}. Open the DOT app and go online to take it."
 * Optional:
 *   INFOBIP_RIDER_ALERT_LANGUAGES  approved template language codes, e.g. "en_GB,pt_PT"
 *                                  (default "en"); a rider gets their app
 *                                  language when it is in this list.
 *   RIDER_ALERT_COOLDOWN_MINUTES   at most one alert per rider in this
 *                                  window (default 15).
 */
import { sendWhatsAppTemplate } from './infobipWhatsApp.js';
import { getUserLanguages } from './i18n.js';

const lastAlertAt = new Map(); // courier id → ms; per server instance, best-effort

export function riderWhatsAppAlertsEnabled() {
  return Boolean(
    process.env.INFOBIP_API_KEY &&
      process.env.INFOBIP_BASE_URL &&
      process.env.INFOBIP_RIDER_ALERT_TEMPLATE,
  );
}

function cooldownMs() {
  const minutes = Number(process.env.RIDER_ALERT_COOLDOWN_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : 15) * 60 * 1000;
}

/** Approved template language codes, exactly as WhatsApp lists them (en, en_GB, pt_PT…). */
function templateLanguages() {
  return String(process.env.INFOBIP_RIDER_ALERT_LANGUAGES || 'en')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The approved code for a rider's app language ('pt' → 'pt_PT'), else the first one. */
function pickTemplateLanguage(appLanguage, allowed) {
  const match = allowed.find((code) => code.toLowerCase().split(/[_-]/)[0] === appLanguage);
  return match || allowed[0] || 'en';
}

/** WhatsApp wants digits with the country code: "+263 77 123 4567" → "263771234567". */
export function riderWhatsAppNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0') && digits.length === 10) return `263${digits.slice(1)}`; // local Zimbabwe 07…
  return digits.length >= 10 ? digits : null;
}

/**
 * Sends the alert to approved, offline riders. Never throws: an order must not
 * fail because WhatsApp did. Returns { sent, skipped, failed } for logging.
 */
export async function alertOfflineRiders(supabase, { storeName, excludeCourierId = null, now = Date.now() } = {}) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!supabase || !riderWhatsAppAlertsEnabled()) return result;
  try {
    const { data: riders, error } = await supabase
      .from('couriers')
      .select('id, user_profiles ( phone )')
      .eq('is_verified', true)
      .eq('verification_status', 'approved')
      .eq('is_online', false);
    if (error) throw error;
    const targets = (riders || []).filter((r) => r.id !== excludeCourierId);
    if (!targets.length) return result;

    const languages = await getUserLanguages(supabase, targets.map((r) => r.id));
    const allowed = templateLanguages();
    const wait = cooldownMs();
    const store = storeName || 'a store near you';

    await Promise.all(
      targets.map(async (rider) => {
        const to = riderWhatsAppNumber(rider.user_profiles?.phone);
        const last = lastAlertAt.get(rider.id) || 0;
        if (!to || now - last < wait) {
          result.skipped += 1;
          return;
        }
        lastAlertAt.set(rider.id, now);
        const lang = languages.get(rider.id);
        try {
          await sendWhatsAppTemplate({
            to,
            placeholders: [store],
            templateName: process.env.INFOBIP_RIDER_ALERT_TEMPLATE,
            language: pickTemplateLanguage(lang, allowed),
          });
          result.sent += 1;
        } catch (err) {
          lastAlertAt.delete(rider.id); // let the next order try again
          result.failed += 1;
          console.warn('[RiderWhatsApp] alert failed for courier', rider.id, err?.message);
        }
      }),
    );
  } catch (err) {
    console.warn('[RiderWhatsApp] could not alert riders:', err?.message || err);
  }
  if (result.sent || result.failed) console.log('[RiderWhatsApp]', result);
  return result;
}
