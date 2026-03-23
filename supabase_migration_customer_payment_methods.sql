-- Run in Supabase SQL Editor if GET /users/me/payment-methods returns 500
-- (usually: relation "customer_payment_methods" does not exist).

CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('card', 'mobile_money', 'cash')),
  provider TEXT,
  last_four_digits TEXT,
  expiry_date TEXT,
  phone_country_code TEXT,
  phone_number TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_customer_id ON customer_payment_methods(customer_id);

ALTER TABLE customer_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers can manage own payment methods" ON customer_payment_methods;
CREATE POLICY "Customers can manage own payment methods" ON customer_payment_methods
  FOR ALL USING (auth.uid() = customer_id);
