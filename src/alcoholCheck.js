import { looksLiquor } from './storeCategorySuggestions.js';

const ID_PHOTO_BUCKET = process.env.SUPABASE_COURIER_BUCKET || 'courier-documents';
const ALLOWED_ID_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const MAX_ID_PHOTO_BYTES = 8 * 1024 * 1024;

const SAFE_ITEM = /\b(non[-\s]?alcoholic|alcohol[-\s]?free|mocktails?|mixers?|soft\s+drinks?|sodas?|mineral\s+water|waters?|juices?|snacks?|chips?|crisps?|vapes?|tobaccos?|cigarettes?|chocolates?|sweets?|energy\s+drinks?|colas?|cokes?|sprite|fanta|schweppes|tonics?|ginger\s+ale|root\s+beer|ginger\s+beer|wine\s+vinegar|malt\s+vinegar|beer\s+batter)\b/i;

const ALCOHOL_ITEM = /\b(beers?|lagers?|stouts?|pales?\s+ales?|ales?|ciders?|wines?|champagnes?|prosecco|whisk(?:e)?ys?|vodkas?|gins?|rums?|brand(?:y|ies)|tequilas?|liqueurs?|liquors?|spirits?|bourbons?|scotches?|cognacs?|mezcals?|sakes?|sojus?|cabernets?|merlots?|chardonnays?|sauvignons?|pinots?|shiraz(?:es)?|ros[eé]s?|castle(?:\s+lite)?|black\s+label|lion\s+lager|zambezi|hunters?|savanna|brutal\s+fruit|flying\s+fish|heineken|corona|budweiser|stella(?:\s+artois)?|guinness|smirnoff|jameson|johnnie\s+walker|jack\s+daniels?|amarula|klipdrift|mainstay|gordons?|absolut|tanqueray|bacardi|captain\s+morgan)\b/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function itemLooksAlcoholic({ name, categoryName, liquorStore = false }) {
  const label = `${categoryName || ''} ${name || ''}`.replace(/\s+/g, ' ').trim();
  if (!label) return Boolean(liquorStore);
  if (SAFE_ITEM.test(label)) return false;
  if (ALCOHOL_ITEM.test(label)) return true;
  return Boolean(liquorStore);
}

async function storeLooksLikeLiquor(supabase, storeId) {
  if (!storeId) return false;
  const { data: store, error } = await supabase
    .from('stores')
    .select('store_name, category_override, merchants(business_type)')
    .eq('id', storeId)
    .maybeSingle();
  if (error || !store) return false;
  const merchant = Array.isArray(store.merchants) ? store.merchants[0] : store.merchants;
  let businessType = merchant?.business_type || store.category_override || '';
  if (UUID_RE.test(String(businessType))) {
    const { data: typeRow } = await supabase
      .from('business_types')
      .select('name')
      .eq('id', businessType)
      .maybeSingle();
    businessType = typeRow?.name || store.category_override || '';
  }
  return looksLiquor(businessType, store.store_name);
}

/** True when any line on the order is alcohol, from any shop. */
export async function orderRequiresIdCheck(supabase, orderId) {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, store_id')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message || 'Failed to load order');
  if (!order) return false;

  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('product_id, product_name')
    .eq('order_id', orderId);
  if (itemsError) throw new Error(itemsError.message || 'Failed to load order items');
  if (!items?.length) return false;

  const productIds = [...new Set(items.map((item) => item.product_id).filter(Boolean))];
  const categoryByProduct = new Map();
  if (productIds.length) {
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, name, product_categories(name)')
      .in('id', productIds);
    if (productsError) throw new Error(productsError.message || 'Failed to load products');
    for (const product of products || []) {
      const category = Array.isArray(product.product_categories)
        ? product.product_categories[0]?.name
        : product.product_categories?.name;
      categoryByProduct.set(product.id, { name: product.name, categoryName: category || '' });
    }
  }

  const liquorStore = await storeLooksLikeLiquor(supabase, order.store_id);
  return items.some((item) => {
    const product = categoryByProduct.get(item.product_id);
    return itemLooksAlcoholic({
      name: item.product_name || product?.name,
      categoryName: product?.categoryName,
      liquorStore,
    });
  });
}

/** Store the handover ID photo and return its URL. */
export async function saveCustomerIdPhoto(supabase, { orderId, dataUrl }) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error('Photograph the customer ID before completing this delivery.');
    error.status = 400;
    throw error;
  }
  const mime = match[1].toLowerCase();
  if (!ALLOWED_ID_MIME.has(mime)) {
    const error = new Error('The ID photo must be a JPEG, PNG, or WebP image.');
    error.status = 400;
    throw error;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ID_PHOTO_BYTES) {
    const error = new Error('The ID photo is empty or too large. Take it again.');
    error.status = 400;
    throw error;
  }
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const path = `age-verification/${orderId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from(ID_PHOTO_BUCKET).upload(path, buffer, {
    contentType: mime === 'image/jpg' ? 'image/jpeg' : mime,
    upsert: false,
  });
  if (uploadError) {
    console.error('customer ID photo upload error:', uploadError);
    const error = new Error(uploadError.message || 'Could not save the ID photo. Try again.');
    error.status = 500;
    throw error;
  }
  const { data: urlData } = supabase.storage.from(ID_PHOTO_BUCKET).getPublicUrl(path);
  return urlData?.publicUrl || path;
}
