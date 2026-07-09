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

// ── Category photo picking ─────────────────────────────────────
// Categories display as small photos in the customer app. Each category
// resolves to a photo from a curated library (same Unsplash CDN the app
// already uses); Claude matches brand-new merchant-invented categories
// to the best library photo. The chosen URL is cached in the
// business_types.icon column so it is only ever resolved once.

const IMG = (id) => `https://images.unsplash.com/${id}?w=200&h=200&fit=crop&q=80`;

export const CATEGORY_IMAGE_LIBRARY = {
  bakery: IMG('photo-1509440159596-0249088772ff'),
  groceries: IMG('photo-1542838132-92c53300491e'),
  pharmacy: IMG('photo-1471864190281-a93a3070b6de'),
  restaurant: IMG('photo-1546069901-ba9599a7e63c'),
  fast_food: IMG('photo-1550547660-d9450f859349'),
  pizza: IMG('photo-1513104890138-7c749659a591'),
  coffee: IMG('photo-1509042239860-f550ce710b93'),
  liquor: IMG('photo-1510812431401-41d2bd2722f3'),
  butchery: IMG('photo-1558030006-450675393462'),
  fruits_veg: IMG('photo-1512621776951-a57141f2eefd'),
  hardware: IMG('photo-1504148455328-c376907d081c'),
  flowers: IMG('photo-1490750967868-88aa4486c946'),
  gifts: IMG('photo-1549465220-1a8b9238cd48'),
  electronics: IMG('photo-1511707171634-5f897ff02aa9'),
  fashion: IMG('photo-1445205170230-053b83016050'),
  shoes: IMG('photo-1542291026-7eec264c27ff'),
  books: IMG('photo-1512820790803-83ca734da794'),
  pets: IMG('photo-1450778869180-41d0601e046e'),
  desserts: IMG('photo-1563805042-7684c019e1cb'),
  cakes: IMG('photo-1578985545062-69928b1d9587'),
  sushi: IMG('photo-1579871494447-9811cf80d66c'),
  beauty: IMG('photo-1560066984-138dadb4c035'),
  general_store: IMG('photo-1441986300917-64674bd600d8'),
};

const IMAGE_KEYWORDS = [
  ['bak', 'bakery'], ['bread', 'bakery'], ['pastr', 'bakery'],
  ['grocer', 'groceries'], ['retail', 'groceries'], ['supermarket', 'groceries'],
  ['pharma', 'pharmacy'], ['health', 'pharmacy'], ['clinic', 'pharmacy'],
  ['pizza', 'pizza'], ['fast', 'fast_food'], ['burger', 'fast_food'], ['chicken', 'fast_food'],
  ['restaurant', 'restaurant'], ['food', 'restaurant'],
  ['coffee', 'coffee'], ['cafe', 'coffee'],
  ['liquor', 'liquor'], ['bottle', 'liquor'], ['bar', 'liquor'], ['wine', 'liquor'],
  ['butcher', 'butchery'], ['meat', 'butchery'], ['fish', 'butchery'],
  ['fruit', 'fruits_veg'], ['veg', 'fruits_veg'], ['farm', 'fruits_veg'],
  ['hardware', 'hardware'], ['tool', 'hardware'], ['build', 'hardware'],
  ['florist', 'flowers'], ['flower', 'flowers'], ['gift', 'gifts'],
  ['beauty', 'beauty'], ['salon', 'beauty'], ['barber', 'beauty'],
  ['electronic', 'electronics'], ['phone', 'electronics'], ['computer', 'electronics'],
  ['cloth', 'fashion'], ['fashion', 'fashion'], ['shoe', 'shoes'],
  ['book', 'books'], ['stationer', 'books'], ['pet', 'pets'],
  ['ice cream', 'desserts'], ['creamy', 'desserts'], ['dessert', 'desserts'], ['cake', 'cakes'],
  ['sushi', 'sushi'], ['asian', 'sushi'],
];

export function isImageIcon(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

export function fallbackCategoryImage(name) {
  const lower = String(name || '').toLowerCase();
  for (const [keyword, key] of IMAGE_KEYWORDS) {
    if (lower.includes(keyword)) return CATEGORY_IMAGE_LIBRARY[key];
  }
  return CATEGORY_IMAGE_LIBRARY.general_store;
}

/**
 * Photo URL for a category name. Claude matches new/unusual categories
 * to the closest library photo when configured; keyword fallbacks
 * otherwise. Never throws.
 */
export async function pickCategoryImage(name) {
  const client = getAnthropicClient();
  if (!client) return fallbackCategoryImage(name);
  try {
    const keys = Object.keys(CATEGORY_IMAGE_LIBRARY);
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system:
        'You match a store category to the best photo key from a fixed list for a delivery app. ' +
        `Available keys: ${keys.join(', ')}. ` +
        'Respond with ONLY one key from the list, nothing else.',
      messages: [{ role: 'user', content: `Category: ${name}` }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim().toLowerCase() || '';
    const key = keys.find((k) => text === k || text.includes(k));
    return key ? CATEGORY_IMAGE_LIBRARY[key] : fallbackCategoryImage(name);
  } catch (err) {
    console.warn('[CategoryImage] AI pick failed for', name, '-', err?.message);
    return fallbackCategoryImage(name);
  }
}
