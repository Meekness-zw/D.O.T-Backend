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
      description: 'A single emoji that visually represents the new category, e.g. "🐾" for Pet Shop, "📚" for Bookstore, "💐" for Florist',
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

// ── Category emoji picking ─────────────────────────────────────
// Categories display as picture-style emoji icons in the customer app.
// Claude picks the emoji once per category; the result is cached in the
// business_types.icon column so it is never fetched twice.

export function isEmojiIcon(value) {
  return typeof value === 'string' && /\p{Extended_Pictographic}/u.test(value);
}

const EMOJI_FALLBACKS = [
  ['bak', '🥐'], ['bread', '🍞'], ['pastr', '🥐'],
  ['grocer', '🛒'], ['retail', '🛒'], ['supermarket', '🛒'],
  ['pharma', '💊'], ['health', '💊'], ['clinic', '🩺'],
  ['restaurant', '🍽️'], ['food', '🍽️'], ['fast', '🍔'], ['burger', '🍔'],
  ['pizza', '🍕'], ['chicken', '🍗'], ['coffee', '☕'], ['cafe', '☕'],
  ['liquor', '🍾'], ['bottle', '🍾'], ['bar', '🍺'], ['wine', '🍷'],
  ['butcher', '🥩'], ['meat', '🥩'], ['fish', '🐟'],
  ['fruit', '🥦'], ['veg', '🥦'], ['farm', '🌽'],
  ['hardware', '🔧'], ['tool', '🔧'], ['build', '🧱'],
  ['florist', '💐'], ['flower', '💐'], ['gift', '🎁'],
  ['beauty', '💄'], ['salon', '💇'], ['barber', '💈'],
  ['electronic', '📱'], ['phone', '📱'], ['computer', '💻'],
  ['cloth', '👕'], ['fashion', '👗'], ['shoe', '👟'],
  ['book', '📚'], ['stationer', '✏️'], ['pet', '🐾'],
  ['ice cream', '🍦'], ['creamy', '🍦'], ['dessert', '🍰'], ['cake', '🍰'],
  ['sushi', '🍣'], ['asian', '🍜'], ['dairy', '🥛'], ['snack', '🍿'],
];

export function fallbackCategoryEmoji(name) {
  const lower = String(name || '').toLowerCase();
  for (const [keyword, emoji] of EMOJI_FALLBACKS) {
    if (lower.includes(keyword)) return emoji;
  }
  return '🛍️';
}

/**
 * One emoji for a category name. Uses Claude when configured (handles
 * anything merchants invent), keyword fallbacks otherwise. Never throws.
 */
export async function pickCategoryEmoji(name) {
  const client = getAnthropicClient();
  if (!client) return fallbackCategoryEmoji(name);
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system:
        'You pick one emoji to visually represent a store category in a delivery app. ' +
        'Respond with ONLY the single most fitting emoji — no words, no punctuation.',
      messages: [{ role: 'user', content: `Category: ${name}` }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
    // Take the first emoji grapheme only
    const match = text.match(/\p{Extended_Pictographic}(️)?/u);
    return match ? match[0] : fallbackCategoryEmoji(name);
  } catch (err) {
    console.warn('[CategoryEmoji] AI pick failed for', name, '-', err?.message);
    return fallbackCategoryEmoji(name);
  }
}
