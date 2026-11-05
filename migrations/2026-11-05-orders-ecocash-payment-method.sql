-- Allow direct EcoCash (EcoCash Online Payments API) as an order payment method.
-- Keeps every earlier method so historical rows still validate.
-- Run in the Supabase SQL editor.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (
  payment_method IN ('card', 'mobile_money', 'cash', 'wallet', 'pesepay', 'contipay', 'smilepay', 'ecocash')
);
