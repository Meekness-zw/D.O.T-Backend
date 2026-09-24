-- Allow ZB Smile Cash (Smile & Pay) as a customer checkout method.
-- Contipay stays in the check so any historical rows still validate.
-- Run in the Supabase SQL editor.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (
  payment_method IN ('card', 'mobile_money', 'cash', 'wallet', 'pesepay', 'contipay', 'smilepay')
);
