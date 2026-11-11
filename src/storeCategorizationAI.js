import Anthropic from '@anthropic-ai/sdk';

// AI store categorization: given a store/business name + description, pick the
// best matching business type from the shared business_types lookup table, or
// propose a brand-new category when nothing fits.
// Requires ANTHROPIC_API_KEY in the environment.

let anthropicClient = null;
let creditsPausedUntil = 0;

export function anthropicCreditsPaused() {
  return Date.now() < creditsPausedUntil;
}

function noteAnthropicError(err) {
  const message = String(err?.message || err || '');
  if (!/credit balance is too low|plans & billing/i.test(message)) return false;
  const alreadyPaused = Date.now() < creditsPausedUntil;
  creditsPausedUntil = Date.now() + 12 * 60 * 60 * 1000;
  if (!alreadyPaused) {
    console.warn(
      '[CategoryVerify] Anthropic credits are exhausted. Automatic category checks are paused for 12 hours. Stores keep their current categories.',
    );
  }
  return true;
}

/** Immediate corrections for unmistakable specialist stores. */
export function inferStrongStoreCategory(storeName, description) {
  const text = `${storeName || ''} ${description || ''}`.toLowerCase();
  const rules = [
    [/(butcher|butchery|meat shop|meat market|abattoir)/, 'Butchery'],
    [/(greengrocer|fruit(?:s)?\s*(?:&|and)\s*veg|produce market)/, 'Fruits & Veg'],
    [/(pharmacy|chemist|dispensary|drugstore)/, 'Pharmacy'],
    [/(bakery|patisserie|boulangerie)/, 'Bakery'],
    [/(liquor store|bottle store|bottle shop|off[- ]licen[cs]e)/, 'Liquor'],
    [/(hardware store|building supplies|diy store)/, 'Hardware'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || null;
}

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
  if (anthropicCreditsPaused()) throw new Error('AI categorization paused: Anthropic credits are exhausted');

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
  const existing = (categoryNames || []).filter(Boolean);
  if (existing.length === 0) return null;
  // The check may also place a store in a specialist category that doesn't
  // exist yet (a sushi place → "Sushi"); the caller creates it with its icon.
  const names = [...existing, ...missingSpecialties(existing)];

  // Resolve strong, unambiguous signals locally before calling the model. This
  // keeps categorisation correct even when the AI provider is unavailable and
  // prevents a broad type such as Grocery from swallowing a dedicated type.
  const haystack = `${storeName || ''} ${description || ''}`.toLowerCase();
  const exactCategory = (candidates) => {
    const wanted = candidates.map((v) => v.toLowerCase());
    return names.find((name) => wanted.includes(name.toLowerCase())) || null;
  };
  const strongRules = [
    [/(butcher|butchery|meat shop|meat market|abattoir)/, ['Butchery', 'Butcher']],
    [/(greengrocer|fruit(?:s)?\s*(?:&|and)\s*veg|produce market)/, ['Fruits & Veg', 'Fruit & Vegetables', 'Produce']],
    [/(pharmacy|chemist|dispensary|drugstore)/, ['Pharmacy']],
    [/(bakery|patisserie|boulangerie)/, ['Bakery']],
    [/(liquor store|bottle store|bottle shop|off[- ]licen[cs]e)/, ['Liquor', 'Liquor Store']],
    [/(hardware store|building supplies|diy store)/, ['Hardware']],
  ];
  for (const [pattern, candidates] of strongRules) {
    if (pattern.test(haystack)) {
      const match = exactCategory(candidates);
      if (match) return match;
    }
  }

  // Food outlets filed under a broad food category (or none): obvious
  // specialities are recognised without the AI, so they still move when the
  // AI is unavailable. Most specific first (sushi before Asian).
  const declaredLower = String(declaredType || '').toLowerCase();
  const broadFood = !declaredLower || /restaurant|food|take ?away|cafe|eat/.test(declaredLower);
  if (broadFood) {
    const foodRules = [
      [/\bsushi\b/, ['Sushi']],
      [/\bpizz(a|eria)/, ['Pizza']],
      [/\b(chicken|wings|poultry)\b/, ['Chicken']],
      [/\b(burgers?|fast food|take ?aways?)\b/, ['Fast Food']],
      [/\b(mexican|tacos?|burritos?)\b/, ['Mexican']],
      [/\b(chinese|japanese|thai|korean|asian|noodles?|ramen|dim sum)\b/, ['Asian']],
      [/\b(desserts?|ice ?cream|cakes?|cupcakes?|waffles?|donuts?|doughnuts?)\b/, ['Desserts']],
    ];
    for (const [pattern, candidates] of foodRules) {
      if (pattern.test(haystack)) {
        const match = exactCategory(candidates);
        if (match) return match;
      }
    }
  }

  const client = getAnthropicClient();
  if (!client || anthropicCreditsPaused()) return null;
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
        'Prefer the most specific category that describes what the store mainly sells: a sushi restaurant ' +
        'belongs in "Sushi", a pizzeria in "Pizza", a cake shop in "Desserts" or "Bakery", rather than a broad ' +
        'category like "Restaurant / Food" or "Grocery / Retail". Use a broad category only when the store sells ' +
        'a wide mix or nothing more specific in the list fits. ' +
        'If the merchant-selected category is already the most specific fit, respond with it unchanged. ' +
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
    if (!noteAnthropicError(err)) {
      console.warn('[CategoryVerify] failed for', storeName, '-', err?.message);
    }
    return null;
  }
}

// ── Category image picking ─────────────────────────────────────
// Categories display as the brand's bundled 3D images in the app. The
// backend stores a compact "dot:<key>" reference per business type;
// Claude matches brand-new merchant-invented categories to the best
// key once, cached in business_types.icon forever after.

// Specialist categories the automatic check may create on its own, each with
// its own bundled icon. Merchants can still type any category themselves;
// automatic placement never invents names outside this list.
export const SPECIALTY_CATEGORIES = [
  ['Sushi', 'sushi'], ['Pizza', 'pizza'], ['Chicken', 'chicken'], ['Fast Food', 'fast_food'],
  ['Asian', 'asian'], ['Mexican', 'mexican'], ['Desserts', 'desserts'], ['Bakery', 'bakery'],
  ['Snacks', 'snacks'], ['Wine', 'wine'], ['Liquor', 'liquor'], ['Flowers', 'flowers'],
  ['Beauty', 'beauty'], ['Tobacco', 'tobacco'], ['Butchery', 'butchery'], ['Fruits & Veg', 'fruits_veg'],
  ['Groceries', 'groceries'], ['Pharmacy', 'pharmacy'], ['Hardware', 'hardware'],
];

// Words that don't say what kind of store it is ("Restaurant / Food" must not block "Fast Food").
const GENERIC_WORDS = new Set(['food', 'store', 'shop', 'retail', 'service', 'general', 'restaurant', 'bottle']);
const categoryWords = (name) =>
  String(name || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/ies$/, 'y').replace(/(es|s)$/, ''))
    .filter((w) => !GENERIC_WORDS.has(w));

/** Specialties with no existing category of the same kind ("Hardware Store" covers "Hardware"). */
export function missingSpecialties(existingNames) {
  const taken = new Set((existingNames || []).flatMap(categoryWords));
  return SPECIALTY_CATEGORIES.map(([name]) => name).filter(
    (name) => !categoryWords(name).some((w) => taken.has(w)),
  );
}

/** The bundled icon for a specialist category name, or null. */
export function specialtyIcon(name) {
  const hit = SPECIALTY_CATEGORIES.find(([n]) => n.toLowerCase() === String(name || '').trim().toLowerCase());
  return hit ? 'dot:' + hit[1] : null;
}

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
  if (!client || anthropicCreditsPaused()) return fallbackCategoryImage(name);
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
    if (!noteAnthropicError(err)) {
      console.warn('[CategoryImage] AI pick failed for', name, '-', err?.message);
    }
    return fallbackCategoryImage(name);
  }
}
