import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

const { missingSpecialties, specialtyIcon, verifyStoreCategory } = await import('../src/storeCategorizationAI.js');

const DEFAULTS = ['Restaurant / Food', 'Grocery / Retail', 'Pharmacy', 'Hardware Store', 'Liquor store / Bottle shop', 'Butchery', 'Fruits & Veg'];

test('specialist categories are offered only when nothing of that kind exists', () => {
  const missing = missingSpecialties(DEFAULTS);
  for (const name of ['Sushi', 'Pizza', 'Fast Food', 'Desserts']) assert.ok(missing.includes(name), name);
  // Already covered by "Grocery / Retail", "Hardware Store", "Liquor store / Bottle shop", "Butchery"…
  for (const name of ['Groceries', 'Hardware', 'Liquor', 'Butchery', 'Fruits & Veg', 'Pharmacy']) {
    assert.ok(!missing.includes(name), name);
  }
  assert.ok(!missingSpecialties([...DEFAULTS, 'Sushi']).includes('Sushi'));
});

test('specialist categories carry their own icon; typed-in ones do not', () => {
  assert.equal(specialtyIcon('Sushi'), 'dot:sushi');
  assert.equal(specialtyIcon('fast food'), 'dot:fast_food');
  assert.equal(specialtyIcon('Pet Shop'), null);
});

test('an unmistakable store lands in its specialist category even before it exists', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const got = await verifyStoreCategory({
      storeName: 'Mbare Bakery',
      description: 'fresh bread daily',
      declaredType: 'Grocery / Retail',
      categoryNames: DEFAULTS,
    });
    assert.equal(got, 'Bakery');
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('obvious food outlets under Restaurant / Food move without the AI', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const check = (storeName, description, declaredType = 'Restaurant / Food') =>
    verifyStoreCategory({ storeName, description, declaredType, categoryNames: DEFAULTS });
  try {
    assert.equal(await check('Yummy Sushi', 'Sushi Restaurant'), 'Sushi');
    assert.equal(await check('Chicken Basket', ''), 'Chicken');
    assert.equal(await check('Dough By Zo', 'American and Mexican cuisine.'), 'Mexican');
    assert.equal(await check('Chuan Fu Lou', 'Chinese Restaurant'), 'Asian');
    // Nothing obvious: left to the AI (unavailable here), so unchanged.
    assert.equal(await check('LaCasa Restaurant & Bar', 'Serving Authentic West African Cuisine'), null);
    // Only broad food picks are second-guessed this way.
    assert.equal(await check('Corner Grocer', 'bread, milk and chicken', 'Grocery / Retail'), null);
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('settling a store creates the category it belongs in and files the store there', async () => {
  const writes = [];
  const types = [{ id: 'restaurant', name: 'Restaurant / Food', icon: 'dot:fast_food' }];
  const table = (name) => {
    const q = {
      _name: name,
      select: () => q,
      eq: () => q,
      order: () => q,
      ilike: () => q,
      limit: () => q,
      single: async () => ({ data: q._row, error: null }),
      insert: (row) => {
        writes.push([name, 'insert', row]);
        types.push(row);
        q._row = row;
        return q;
      },
      update: (row) => {
        writes.push([name, 'update', row]);
        return q;
      },
      then: (resolve) => resolve({ data: name === 'business_types' ? types : null, error: null }),
    };
    return q;
  };
  mock.module('../src/supabaseAdminClient.js', { namedExports: { supabaseAdmin: { from: table } } });
  mock.module('../src/storeCategorizationAI.js', {
    namedExports: {
      verifyStoreCategory: async () => 'Sushi',
      pickCategoryImage: async () => 'dot:all',
      specialtyIcon,
    },
  });
  const { settleStoreCategory } = await import('../src/storeCategory.js?settle');
  const shownAs = await settleStoreCategory({
    storeId: 's1',
    storeName: 'Yummy Sushi',
    description: 'sushi and rolls',
    declaredType: 'Restaurant / Food',
  });
  assert.equal(shownAs, 'Sushi');
  const created = writes.find((w) => w[1] === 'insert')[2];
  assert.match(created.id, /^[0-9a-f-]{36}$/); // business_types.id is a uuid
  assert.deepEqual({ ...created, id: undefined }, { id: undefined, name: 'Sushi', icon: 'dot:sushi', is_default: false });
  assert.deepEqual(writes.find((w) => w[0] === 'stores')[2], { category_override: 'Sushi' });
});
