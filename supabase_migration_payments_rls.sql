-- Run this if you already applied the main schema and only need the payments RLS policy.
-- Customers can view their own payments.
CREATE POLICY "Customers can view own payments" ON payments
  FOR SELECT USING (auth.uid() = customer_id);
