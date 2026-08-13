-- The app already ships dedicated customer-facing tabs/artwork for several
-- business types (see frontend/utils/categoryImages.js) that were never
-- actually seeded into business_types. A merchant onboarding a butchery or
-- fruit/veg market has no matching card to pick, so they land on the
-- closest visible option ("Grocery / Retail") and get miscategorized —
-- the AI category-verification safety net (storeCategorizationAI.js) can
-- only pick among names that already exist in this table, so it can't
-- correct this on its own either. Seeding these closes that gap.
INSERT INTO business_types (name, icon, is_custom, is_default) VALUES
  ('Butchery', 'package', FALSE, TRUE),
  ('Fruits & Veg', 'shopping-bag', FALSE, TRUE)
ON CONFLICT (name) DO NOTHING;
