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

test('settling a store creates the category it belongs in and files the store there', async () => {
  const writes = [];
  const types = [{ id: 'restaurant', name: 'Restaurant / Food', icon: 'dot:fast_food' }];
  const table = (name) => {
    const q = {
      _name: name,
      select: () => q,
      eq: () => q,
      order: () => q,
      single: async () => ({ data: q._row, error: null }),
      upsert: (row) => {
        writes.push([name, 'upsert', row]);
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
  assert.deepEqual(writes.find((w) => w[1] === 'upsert')[2], { id: 'sushi', name: 'Sushi', icon: 'dot:sushi', is_default: false });
  assert.deepEqual(writes.find((w) => w[0] === 'stores')[2], { category_override: 'Sushi' });
});
