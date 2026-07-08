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
      description: 'A Feather icon name that suits the new category, e.g. "scissors", "book", "heart", "gift", "truck", "tool"',
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
