/**
 * Puts a store in the right customer-facing category.
 *
 * The merchant's pick (from the list, or typed in themselves) is checked
 * against the store's name and description (storeCategorizationAI.js). When
 * the check says a category that doesn't exist yet fits best, e.g. "Sushi"
 * for a sushi restaurant filed under "Restaurant / Food", it is created
 * here with its icon, so it shows up as a category tab in the app.
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';
import { verifyStoreCategory, pickCategoryImage, specialtyIcon } from './storeCategorizationAI.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function categorySlug(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** The category with this name, created (with an icon) when it doesn't exist. */
export async function ensureBusinessType(name) {
  const label = String(name || '').trim();
  if (!label || UUID.test(label) || label.length > 60) return null;
  const { data: types, error } = await supabase.from('business_types').select('id, name, icon');
  if (error) throw new Error(error.message);
  const existing = (types || []).find((t) => String(t.name || '').toLowerCase() === label.toLowerCase());
  if (existing) return existing;
  const icon = specialtyIcon(label) || (await pickCategoryImage(label));
  const { data, error: upsertError } = await supabase
    .from('business_types')
    .upsert({ id: categorySlug(label), name: label, icon, is_default: false }, { onConflict: 'id' })
    .select('id, name, icon')
    .single();
  if (upsertError) throw new Error(upsertError.message);
  console.log(`[Category] created "${label}" (${icon})`);
  return data;
}

/**
 * Check a store's category and save the result on the store. Never throws;
 * returns the category the store is shown under, or null when the check
 * couldn't run (the merchant's own pick is then shown).
 */
export async function settleStoreCategory({ storeId, storeName, description, declaredType }) {
  try {
    if (!supabase || !storeId) return null;
    const declared = String(declaredType || '').trim();
    const { data: types } = await supabase.from('business_types').select('name');
    const names = (types || []).map((t) => t.name).filter(Boolean);
    // A category the merchant typed themselves is a candidate too.
    const typedOwn = declared && !UUID.test(declared) && !names.some((n) => n.toLowerCase() === declared.toLowerCase());
    if (typedOwn) names.push(declared);

    const verified = await verifyStoreCategory({
      storeName: String(storeName || '').trim(),
      description: String(description || '').trim(),
      declaredType: declared,
      categoryNames: names,
    });

    // Check unavailable: a typed-in category still becomes a real one.
    const chosen = verified || (typedOwn ? declared : null);
    if (!chosen) return null;
    const row = await ensureBusinessType(chosen);
    const shownAs = row?.name || chosen;
    if (verified) {
      await supabase.from('stores').update({ category_override: shownAs }).eq('id', storeId);
      if (shownAs.toLowerCase() !== declared.toLowerCase()) {
        console.log(`[CategoryVerify] ${storeName}: "${declared}" → "${shownAs}"`);
      }
    }
    return verified ? shownAs : null;
  } catch (err) {
    console.warn('[CategoryVerify] skipped for', storeName, '-', err?.message);
    return null;
  }
}
