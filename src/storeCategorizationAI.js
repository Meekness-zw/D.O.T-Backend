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

// ── Category sticker picking ───────────────────────────────────
// Categories display as 3D cartoon stickers in the customer app. Each
// category resolves to a sticker from a curated library; Claude matches
// brand-new merchant-invented categories to the best one. The chosen
// URL is cached in business_types.icon so it is only resolved once.

const CDN = 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets';
const IMG = (path) => `${CDN}/${path.split('/').map(encodeURIComponent).join('/')}`;

// 3D cartoon stickers (transparent background) — Microsoft Fluent emoji,
// MIT licensed. Every URL verified live.
export const CATEGORY_IMAGE_LIBRARY = {
  bakery: IMG('Croissant/3D/croissant_3d.png'),
  bread: IMG('Bread/3D/bread_3d.png'),
  groceries: IMG('Shopping cart/3D/shopping_cart_3d.png'),
  pharmacy: IMG('Pill/3D/pill_3d.png'),
  restaurant: IMG('Fork and knife with plate/3D/fork_and_knife_with_plate_3d.png'),
  fast_food: IMG('Hamburger/3D/hamburger_3d.png'),
  pizza: IMG('Pizza/3D/pizza_3d.png'),
  chicken: IMG('Poultry leg/3D/poultry_leg_3d.png'),
  coffee: IMG('Hot beverage/3D/hot_beverage_3d.png'),
  liquor: IMG('Bottle with popping cork/3D/bottle_with_popping_cork_3d.png'),
  wine: IMG('Wine glass/3D/wine_glass_3d.png'),
  butchery: IMG('Cut of meat/3D/cut_of_meat_3d.png'),
  fruits_veg: IMG('Broccoli/3D/broccoli_3d.png'),
  hardware: IMG('Hammer and wrench/3D/hammer_and_wrench_3d.png'),
  flowers: IMG('Bouquet/3D/bouquet_3d.png'),
  gifts: IMG('Wrapped gift/3D/wrapped_gift_3d.png'),
  electronics: IMG('Mobile phone/3D/mobile_phone_3d.png'),
  fashion: IMG('T-shirt/3D/t-shirt_3d.png'),
  shoes: IMG('Running shoe/3D/running_shoe_3d.png'),
  books: IMG('Books/3D/books_3d.png'),
  pets: IMG('Paw prints/3D/paw_prints_3d.png'),
  desserts: IMG('Soft ice cream/3D/soft_ice_cream_3d.png'),
  cakes: IMG('Shortcake/3D/shortcake_3d.png'),
  sushi: IMG('Sushi/3D/sushi_3d.png'),
  asian: IMG('Steaming bowl/3D/steaming_bowl_3d.png'),
  beauty: IMG('Lipstick/3D/lipstick_3d.png'),
  general_store: IMG('Shopping bags/3D/shopping_bags_3d.png'),
};

const IMAGE_KEYWORDS = [
  ['bak', 'bakery'], ['bread', 'bread'], ['pastr', 'bakery'],
  ['grocer', 'groceries'], ['retail', 'groceries'], ['supermarket', 'groceries'],
  ['pharma', 'pharmacy'], ['health', 'pharmacy'], ['clinic', 'pharmacy'],
  ['pizza', 'pizza'], ['fast', 'fast_food'], ['burger', 'fast_food'], ['chicken', 'chicken'],
  ['restaurant', 'restaurant'], ['food', 'restaurant'],
  ['coffee', 'coffee'], ['cafe', 'coffee'],
  ['liquor', 'liquor'], ['bottle', 'liquor'], ['bar', 'wine'], ['wine', 'wine'],
  ['butcher', 'butchery'], ['meat', 'butchery'], ['fish', 'butchery'],
  ['fruit', 'fruits_veg'], ['veg', 'fruits_veg'], ['farm', 'fruits_veg'],
  ['hardware', 'hardware'], ['tool', 'hardware'], ['build', 'hardware'],
  ['florist', 'flowers'], ['flower', 'flowers'], ['gift', 'gifts'],
  ['beauty', 'beauty'], ['salon', 'beauty'], ['barber', 'beauty'],
  ['electronic', 'electronics'], ['phone', 'electronics'], ['computer', 'electronics'],
  ['cloth', 'fashion'], ['fashion', 'fashion'], ['shoe', 'shoes'],
  ['book', 'books'], ['stationer', 'books'], ['pet', 'pets'],
  ['ice cream', 'desserts'], ['creamy', 'desserts'], ['dessert', 'desserts'], ['cake', 'cakes'],
  ['sushi', 'sushi'], ['asian', 'asian'],
];

export function isImageIcon(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

/** Resolved = points at the cartoon sticker CDN (old photo URLs re-pick). */
export function isCartoonIcon(value) {
  return typeof value === 'string' && value.startsWith(CDN);
}

export function fallbackCategoryImage(name) {
  const lower = String(name || '').toLowerCase();
  for (const [keyword, key] of IMAGE_KEYWORDS) {
    if (lower.includes(keyword)) return CATEGORY_IMAGE_LIBRARY[key];
  }
  return CATEGORY_IMAGE_LIBRARY.general_store;
}

/**
 * Sticker URL for a category name. Claude matches new/unusual
 * categories to the closest library sticker when configured; keyword
 * fallbacks otherwise. Never throws.
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
        'You match a store category to the best cartoon icon key from a fixed list for a delivery app. ' +
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
