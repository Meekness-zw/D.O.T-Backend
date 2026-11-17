/**
 * Server-side wording for notifications, in the language each user picked in
 * the app (user_profiles.app_language: 'en', 'zh', 'pt' or 'es').
 *
 * English is the key, values go in braces:
 *   render('pt', ['Order #{number} was delivered successfully.', { number: '1042' }])
 * A value can itself be a phrase to translate: { order: ['your order'] }.
 * A phrase without a translation is sent in English.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const DICTIONARIES = {
  zh: require('./locales/zh.json'),
  pt: require('./locales/pt.json'),
  es: require('./locales/es.json'),
};

export const APP_LANGUAGES = ['en', 'zh', 'pt', 'es'];

export function normalizeLanguage(code) {
  const c = String(code || '').toLowerCase().slice(0, 2);
  return APP_LANGUAGES.includes(c) ? c : 'en';
}

function phrase(lang, text) {
  const dict = DICTIONARIES[lang];
  return (dict && dict[text]) || text;
}

/** A string, or [template, params] where params may hold phrases too. */
export function render(lang, value) {
  if (value == null) return '';
  if (!Array.isArray(value)) return phrase(lang, String(value));
  const [template, params = {}] = value;
  return phrase(lang, template).replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    if (v == null) return '';
    return Array.isArray(v) ? render(lang, v) : String(v);
  });
}

/** English, for logs and places with no reader (admin views). */
export const english = (value) => render('en', value);

let languageColumnMissing = false;

/**
 * The user's app language, 'en' when unknown. Works before the
 * app_language migration has been run (everyone gets English).
 */
export async function getUserLanguage(supabase, userId) {
  if (!supabase || !userId || languageColumnMissing) return 'en';
  const { data, error } = await supabase
    .from('user_profiles')
    .select('app_language')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    if (/app_language/.test(error.message || '')) languageColumnMissing = true;
    return 'en';
  }
  return normalizeLanguage(data?.app_language);
}

/** Saves the language the app is using. Ignored until the migration is run. */
export async function saveUserLanguage(supabase, userId, code) {
  if (!supabase || !userId || languageColumnMissing || !code) return;
  const { error } = await supabase
    .from('user_profiles')
    .update({ app_language: normalizeLanguage(code) })
    .eq('id', userId);
  if (error && /app_language/.test(error.message || '')) languageColumnMissing = true;
}

/** Languages for many users at once: Map(userId → code). Everyone is 'en' before the migration. */
export async function getUserLanguages(supabase, userIds) {
  const out = new Map();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!supabase || !ids.length || languageColumnMissing) return out;
  const { data, error } = await supabase.from('user_profiles').select('id, app_language').in('id', ids);
  if (error) {
    if (/app_language/.test(error.message || '')) languageColumnMissing = true;
    return out;
  }
  for (const row of data || []) out.set(row.id, normalizeLanguage(row.app_language));
  return out;
}
