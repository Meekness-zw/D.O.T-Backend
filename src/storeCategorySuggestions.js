/**
 * Suggested product_categories (names only) for a new store.
 * Used by merchant onboarding and GET /merchant/stores/:id/categories when the store has no rows yet.
 *
 * Uses business_type plus business_name / store_name so **any** vertical (custom "Other",
 * DB business types, or name hints like "Mike's Pizza") gets a sensible starter menu — not only liquor.
 */

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

const LIQUOR_HINTS = [
  'liquor',
  'bottle shop',
  'bottle store',
  'wine shop',
  'wine store',
  'cellar',
  'off-licence',
  'off license',
  'off-license',
  'alcohol',
  'spirits',
  'shebeen',
  'sabeer',
  'dram shop',
  'whiskey',
  'whisky',
  'vodka',
  'gin bar',
  'wine bar',
  'cocktail',
  ' tavern',
  'tavern ',
  ' pub',
  ' pub ',
];

function looksLiquor(businessType, businessName) {
  const t = `${norm(businessType)} ${norm(businessName)}`.replace(/\s+/g, ' ');
  if (!t.trim()) return false;
  if (t.includes('liquor')) return true;
  if (t.includes('bottle')) return true;
  if (t.includes('wine shop') || t.includes('wine store')) return true;
  if (/\b(cider|beer)\b/.test(t) && (t.includes('shop') || t.includes('store') || t.includes('liquor'))) return true;
  return LIQUOR_HINTS.some((h) => t.includes(h));
}

function liquorCategoryNames(includeVapes) {
  const list = [
    'Best sellers',
    'Spirits',
    'Wines & champagnes',
    'Liqueurs',
    'Ciders & beers',
    'Mixers (non-alcoholic)',
  ];
  if (includeVapes) list.push('Vapes (where permitted)');
  return list;
}

const WITH_BEST = (arr) => (arr.includes('Best sellers') ? arr : [...arr, 'Best sellers']);

/**
 * Rich keyword + label inference on one string: `businessType` + `businessName` / store name.
 * First matching rule wins (order = most specific first).
 */
function inferFromCombinedText(tRaw, opts) {
  const t = tRaw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const includeVapes = opts.includeVapes !== false;

  const rules = [
    [() => looksLiquor('', t) || t.includes('liquor store') || t === 'liquor_store', () => liquorCategoryNames(includeVapes)],
    [() => /(pharmacy|chemist|medicine|dispensary|drugstore)/.test(t), () => WITH_BEST(['Prescription medicines', 'Over-the-counter', 'Vitamins & supplements', 'Personal care', 'Baby & kids'])],
    [() => /(butcher|meat shop|meat market|abattoir)/.test(t), () => WITH_BEST(['Beef', 'Poultry', 'Pork', 'Lamb', 'Prepared meats'])],
    [() => /(bakery|patisserie|boulangerie|cake shop)/.test(t), () => WITH_BEST(['Bread', 'Pastries', 'Cakes', 'Cookies', 'Drinks'])],
    [() => /(coffee|cafe|café|espresso|roastery)/.test(t), () => WITH_BEST(['Hot drinks', 'Cold drinks', 'Pastries', 'Sandwiches', 'Retail'])],
    [() => /(restaurant|takeaway|take away|fast food|pizza|burger|grill|bbq|braai|sushi|noodle|kitchen|diner|canteen|eatery|shawarma|taco)/.test(t), () => WITH_BEST(['Starters', 'Mains', 'Sides', 'Drinks', 'Desserts'])],
    [() => /(grocery|supermarket|minimart|mini mart|tuck shop|spaza|general dealer|greengrocer|produce|fruit and veg|fruit & veg|wholesale food)/.test(t), () => WITH_BEST(['Fruits & vegetables', 'Meat & poultry', 'Dairy & eggs', 'Pantry staples', 'Snacks & drinks'])],
    [() => /(hardware|building supply|timber|plumbing supply|electrical supply|paint shop|diy)/.test(t), () => WITH_BEST(['Tools', 'Building materials', 'Plumbing', 'Electrical', 'Paint & finishes'])],
    [() => /(clothing|fashion|apparel|boutique|tailor|shoes|footwear|sneaker|dress shop)/.test(t), () => WITH_BEST(['New arrivals', 'Tops & shirts', 'Bottoms', 'Outerwear', 'Accessories'])],
    [() => /(electronics|computer|laptop|phone shop|mobile shop|gadget|appliance|\btv\b|audio|hifi|hi-fi)/.test(t), () => WITH_BEST(['Phones & tablets', 'Computers', 'Audio', 'Accessories', 'Parts & cables'])],
    [() => /(furniture|home decor|interior|mattress|curtain|bedding|kitchenware)/.test(t), () => WITH_BEST(['Living', 'Bedroom', 'Dining', 'Kitchen', 'Decor'])],
    [
      () =>
        /(sports shop|sporting goods|gym equipment|fitness store|outdoor gear)/.test(t) ||
        (/\bgym\b/.test(t) && /(shop|store|equipment|supply)/.test(t)),
      () => WITH_BEST(['Equipment', 'Apparel', 'Nutrition', 'Accessories', 'Recovery']),
    ],
    [() => /(baby shop|baby boutique|infant care|nursery store)/.test(t), () => WITH_BEST(['Feeding', 'Diapers', 'Clothing', 'Gear', 'Safety'])],
    [() => /(toy|toys|kids store|children|game store)/.test(t), () => WITH_BEST(['Toys', 'Games', 'Learning', 'Party', 'Seasonal'])],
    [() => /(jewelry|jewellery|jewel|goldsmith|silversmith|watch shop|timepiece)/.test(t), () => WITH_BEST(['Rings', 'Necklaces', 'Watches', 'Gifts', 'Repairs & care'])],
    [() => /(auto parts|car parts|motor spares|tyre|tire|garage shop|vehicle parts|\bautomotive\b)/.test(t), () => WITH_BEST(['Parts', 'Fluids', 'Accessories', 'Tools', 'Tyres'])],
    [() => /(fuel station|petrol station|gas station|filling station)/.test(t), () => WITH_BEST(['Fuel', 'In-store snacks', 'Drinks', 'Car care', 'Convenience'])],
    [() => /(laundry|dry clean|dryclean|washing)/.test(t), () => WITH_BEST(['Wash & fold', 'Dry cleaning', 'Alterations', 'Home textiles', 'Supplies'])],
    [() => /(hotel|lodge|guest house|guesthouse|resort|accommodation|bnb|hostel)/.test(t), () => WITH_BEST(['Souvenirs', 'Snacks & drinks', 'Toiletries', 'Gifts', 'Local specials'])],
    [() => /(photography|photo studio|video|wedding supply|event hire)/.test(t), () => WITH_BEST(['Prints & albums', 'Frames', 'Accessories', 'Services', 'Gifts'])],
    [() => /(security|cctv|surveillance|alarm)/.test(t), () => WITH_BEST(['Cameras', 'Alarms', 'Access control', 'Cabling', 'Installation kits'])],
    [() => /(beauty|salon|cosmetic|barber|spa|makeup|nail bar)/.test(t), () => WITH_BEST(['Hair care', 'Skin care', 'Makeup', 'Fragrance', 'Tools & accessories'])],
    [() => /(\bpet\b|pet shop|pet store|pet food|animal feed|kennel|aquarium)/.test(t), () => WITH_BEST(['Food', 'Treats', 'Toys', 'Grooming', 'Health'])],
    [() => /(flower|florist|nursery|garden centre|garden center|plant shop)/.test(t), () => WITH_BEST(['Bouquets', 'Plants', 'Gifts', 'Seasonal'])],
    [() => /(book|stationery|stationary|school supply|office supply|copy shop|photocopy)/.test(t), () => WITH_BEST(['Books', 'Writing & paper', 'Office', 'Art & craft'])],
    [() => /(farm supply|agri|agricultural|seed shop|feed store|vet supply)/.test(t), () => WITH_BEST(['Seeds', 'Fertiliser', 'Feed', 'Tools', 'Crop care'])],
    [() => /(gift|hamper|party supply|novelty)/.test(t), () => WITH_BEST(['Gifts', 'Cards & wrap', 'Party', 'Seasonal', 'Local makers'])],
    [() => /(art supply|craft|hobby shop)/.test(t), () => WITH_BEST(['Paints', 'Paper & canvas', 'Tools', 'Kits', 'Kids craft'])],
    [() => /(music shop|instrument)/.test(t), () => WITH_BEST(['Instruments', 'Strings & accessories', 'Sheet music', 'Audio', 'Lessons add-ons'])],
    [() => /(bank|forex|bureau de change|money exchange)/.test(t), () => WITH_BEST(['Travel cards', 'Forms & stationery', 'Retail', 'Gifts'])],
    [() => /(travel agency|tourism)/.test(t), () => WITH_BEST(['Packages', 'Add-ons', 'Insurance', 'Retail', 'Gifts'])],
  ];

  for (const [test, get] of rules) {
    try {
      if (test()) return get();
    } catch {
      // ignore
    }
  }
  return null;
}

/** When there are no keyword hits, map common business_type labels (including defaults from onboarding). */
function categoriesFromTypeLabel(type, opts) {
  if (!type) return null;
  const vapes = opts.includeVapes !== false;
  if (type.includes('restaurant') || type.includes('food')) {
    return WITH_BEST(['Starters', 'Mains', 'Sides', 'Drinks', 'Desserts']);
  }
  if (type.includes('grocery') || type.includes('retail')) {
    return WITH_BEST(['Fruits & vegetables', 'Meat & poultry', 'Dairy & eggs', 'Pantry staples', 'Snacks & drinks']);
  }
  if (type.includes('pharmacy')) {
    return WITH_BEST(['Prescription medicines', 'Over-the-counter', 'Vitamins & supplements', 'Personal care', 'Baby & kids']);
  }
  if (type.includes('hardware')) {
    return WITH_BEST(['Tools', 'Building materials', 'Plumbing', 'Electrical', 'Paint & finishes']);
  }
  if (type.includes('bakery')) {
    return WITH_BEST(['Bread', 'Pastries', 'Cakes', 'Cookies', 'Drinks']);
  }
  if (type.includes('liquor') || type === 'liquor_store') {
    return liquorCategoryNames(vapes);
  }
  return null;
}

const DEFAULT_GENERAL = ['Best sellers', 'Shop favourites', 'Everyday essentials', 'Seasonal picks', 'New in store'];

/**
 * @param {string} businessType - Merchant-facing label or id (e.g. "Restaurant / Food", "liquor_store")
 * @param {{ businessName?: string, includeVapes?: boolean }} [options]
 * @returns {string[]}
 */
export function getSuggestedProductCategoryNames(businessType, options = {}) {
  const { businessName = '', includeVapes = true } = options;
  const type = norm(businessType);
  const combined = `${type} ${norm(businessName)}`.replace(/\s+/g, ' ');

  const inferred = inferFromCombinedText(combined, { includeVapes });
  if (inferred) return inferred;

  const fromLabel = categoriesFromTypeLabel(type, { includeVapes });
  if (fromLabel) return fromLabel;

  return DEFAULT_GENERAL;
}
