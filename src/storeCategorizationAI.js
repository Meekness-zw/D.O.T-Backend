import Anthropic from '@anthropic-ai/sdk';

// AI store categorization: given a store/business name + description, pick the
// best matching business type from the shared business_types lookup table, or
// propose a brand-new category when nothing fits.
// Requires ANTHROPIC_API_KEY in the environment.

let anthropicClient = null;

export function isAiCategorizationConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getAnthropicClient() {
  if (!isAiCategorizationConfigured()) return null;
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

const CATEGORIZATION_SCHEMA = {
  type: 'object',
  properties: {
    match_type: {
      type: 'string',
      enum: ['existing', 'new'],
      description: 'existing = one of the provided business types fits; new = none fit, propose a new category',
    },
    business_type_id: {
      type: ['string', 'null'],
      description: 'The id of the matching existing business type (only when match_type is existing)',
    },
    new_type_name: {
      type: ['string', 'null'],
      description: 'Short display label for the proposed new category, e.g. "Pet Shop" (only when match_type is new)',
    },
    new_type_icon: {
      type: ['string', 'null'],
      description: 'Always null — the category photo is assigned automatically after creation',
    },
  },
  required: ['match_type', 'business_type_id', 'new_type_name', 'new_type_icon'],
  additionalProperties: false,
};

/**
 * @param {Object} params
 * @param {string} params.storeName - business/store name entered by the merchant
 * @param {string} [params.description] - what the business does/sells
 * @param {Array<{id: string, name: string}>} params.businessTypes - existing categories
 * @returns {Promise<{match_type: 'existing'|'new', business_type_id: string|null, new_type_name: string|null, new_type_icon: string|null}>}
 */
export async function categorizeStoreWithAI({ storeName, description, businessTypes }) {
  const client = getAnthropicClient();
  if (!client) throw new Error('AI categorization not configured (ANTHROPIC_API_KEY missing)');

  const typeList = (businessTypes || [])
    .map((t) => `- id: "${t.id}" — ${t.name}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 500,
    system:
      'You categorize stores for a delivery marketplace in Zimbabwe. ' +
      'Given a business name and description, pick the single best matching business type from the provided list. ' +
      'Only propose a new category when the business clearly does not fit any existing type — prefer existing types. ' +
      'New category names must be short, generic labels (e.g. "Pet Shop", "Bookstore"), never the store\'s own name.',
    messages: [
      {
        role: 'user',
        content:
          `Existing business types:\n${typeList}\n\n` +
          `Business name: ${storeName}\n` +
          `Description: ${description || '(none provided)'}`,
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: CATEGORIZATION_SCHEMA },
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('AI categorization declined the request');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock?.text) throw new Error('AI categorization returned no result');
  return JSON.parse(textBlock.text);
}

/**
 * Double-checks a merchant's self-declared category against what the store
 * actually is, using its name + description. Merchants sometimes pick the
 * wrong category by mistake (e.g. a butcher selecting "Grocery / Retail");
 * this catches that so it never surfaces as a customer-facing mistake.
 *
 * @param {Object} params
 * @param {string} params.storeName
 * @param {string} [params.description]
 * @param {string} [params.declaredType] - the merchant-selected category name
 * @param {string[]} params.categoryNames - all valid business_types.name values
 * @returns {Promise<string|null>} the best-fit category name, or null if
 *   verification couldn't run (caller should keep the declared type as-is)
 */
export async function verifyStoreCategory({ storeName, description, declaredType, categoryNames }) {
  const client = getAnthropicClient();
  const names = (categoryNames || []).filter(Boolean);
  if (!client || names.length === 0) return null;
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      system:
        'You double-check store categorization for a delivery marketplace. Merchants sometimes pick the wrong ' +
        'category by mistake, and that mistake must never be shown to customers. ' +
        `Given a store's name, description, and the category the merchant selected, pick the single best-fit ` +
        `category from this exact list: ${names.join(', ')}. ` +
        'Trust what the store name and description say it actually sells over the merchant-selected category ' +
        'when they clearly conflict (e.g. a store named "City Butchery" selling meat, selected as "Grocery / Retail", ' +
        'should be corrected to "Butchery" if that option exists). ' +
        'If the merchant-selected category is already reasonable, respond with it unchanged. ' +
        'Respond with ONLY the exact category name from the list, nothing else.',
      messages: [
        {
          role: 'user',
          content:
            `Store name: ${storeName}\n` +
            `Description: ${description || '(none provided)'}\n` +
            `Merchant-selected category: ${declaredType || '(none)'}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
    return names.find((n) => n.toLowerCase() === text.toLowerCase()) || null;
  } catch (err) {
    console.warn('[CategoryVerify] failed for', storeName, '-', err?.message);
    return null;
  }
}

// ── Category image picking ─────────────────────────────────────
// Categories display as the brand's bundled 3D images in the app. The
// backend stores a compact "dot:<key>" reference per business type;
// Claude matches brand-new merchant-invented categories to the best
// key once, cached in business_types.icon forever after.

export const CATEGORY_ICON_KEYS = [
  'bakery', 'groceries', 'pharmacy', 'fast_food', 'pizza', 'chicken',
  'butchery', 'liquor', 'wine', 'flowers', 'hardware', 'fruits_veg',
  'snacks', 'desserts', 'sushi', 'asian', 'mexican', 'tobacco', 'beauty',
  'all',
];

const IMAGE_KEYWORDS = [
  // Specific first — generic terms like grocery/retail/food match last
  ['butcher', 'butchery'], ['meat', 'butchery'], ['fish', 'butchery'],
  ['bak', 'bakery'], ['bread', 'bakery'], ['pastr', 'bakery'],
  ['pharma', 'pharmacy'], ['clinic', 'pharmacy'],
  ['pizza', 'pizza'], ['burger', 'fast_food'], ['chicken', 'chicken'],
  ['coffee', 'bakery'], ['cafe', 'bakery'],
  ['liquor', 'liquor'], ['bottle', 'liquor'], ['wine', 'wine'], ['bar', 'wine'],
  ['fruit', 'fruits_veg'], ['veg', 'fruits_veg'], ['farm', 'fruits_veg'],
  ['hardware', 'hardware'], ['tool', 'hardware'], ['build', 'hardware'],
  ['florist', 'flowers'], ['flower', 'flowers'], ['gift', 'flowers'],
  ['beauty', 'beauty'], ['salon', 'beauty'], ['toiletr', 'beauty'], ['cosmetic', 'beauty'],
  ['snack', 'snacks'], ['chips', 'snacks'],
  ['ice cream', 'desserts'], ['creamy', 'desserts'], ['dessert', 'desserts'], ['cake', 'desserts'],
  ['sushi', 'sushi'], ['asian', 'asian'], ['noodle', 'asian'],
  ['mexican', 'mexican'], ['taco', 'mexican'],
  ['tobacco', 'tobacco'], ['smoke', 'tobacco'], ['vape', 'tobacco'], ['hookah', 'tobacco'],
  ['health', 'pharmacy'],
  ['grocer', 'groceries'], ['retail', 'groceries'], ['supermarket', 'groceries'],
  ['fast', 'fast_food'], ['restaurant', 'fast_food'], ['food', 'fast_food'],
];

export function isImageIcon(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

/** Resolved = a valid "dot:<key>" reference (URLs and legacy re-pick). */
export function isCartoonIcon(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('dot:') &&
    CATEGORY_ICON_KEYS.includes(value.slice(4))
  );
}

export function fallbackCategoryImage(name) {
  const lower = String(name || '').toLowerCase();
  for (const [keyword, key] of IMAGE_KEYWORDS) {
    if (lower.includes(keyword)) return 'dot:' + key;
  }
  return 'dot:all';
}

/**
 * "dot:<key>" reference for a category name. Claude matches new or
 * unusual categories to the closest key when configured; keyword
 * fallbacks otherwise. Never throws.
 */
export async function pickCategoryImage(name) {
  const client = getAnthropicClient();
  if (!client) return fallbackCategoryImage(name);
  try {
    const keys = CATEGORY_ICON_KEYS.filter((k) => k !== 'all');
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system:
        'You match a store category to the best icon key from a fixed list for a delivery app. ' +
        `Available keys: ${keys.join(', ')}. ` +
        "Respond with ONLY one key from the list, or 'all' if nothing fits.",
      messages: [{ role: 'user', content: `Category: ${name}` }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim().toLowerCase() || '';
    const key = CATEGORY_ICON_KEYS.find((k) => text === k || text.includes(k));
    return key ? 'dot:' + key : fallbackCategoryImage(name);
  } catch (err) {
    console.warn('[CategoryImage] AI pick failed for', name, '-', err?.message);
    return fallbackCategoryImage(name);
  }
}
