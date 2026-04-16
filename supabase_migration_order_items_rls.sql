-- Allow customers to insert order_items rows that belong to their own orders.
-- The backend service-role client bypasses RLS automatically, but this policy
-- ensures placement still works if the anon key is used as a fallback.
CREATE POLICY "Customers can insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.customer_id = auth.uid()
    )
  );

-- Allow customers, the order's merchant, and assigned couriers to view order items.
CREATE POLICY "Users can view order items for their orders" ON order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND (
          orders.customer_id = auth.uid()
          OR orders.merchant_id = auth.uid()
          OR orders.courier_id = auth.uid()
        )
    )
  );
