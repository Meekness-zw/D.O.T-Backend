CREATE TABLE IF NOT EXISTS product_suggestions (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  suggested_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, suggested_product_id),
  CONSTRAINT product_suggestions_not_self CHECK (product_id <> suggested_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_suggestions_product
  ON product_suggestions(product_id, display_order);

ALTER TABLE product_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view product suggestions" ON product_suggestions;
CREATE POLICY "Public can view product suggestions"
  ON product_suggestions FOR SELECT USING (true);
