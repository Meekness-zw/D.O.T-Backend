-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--
-- None of the three "Withdraw" buttons in the app (customer/merchant/courier
-- wallet screens) actually did anything — one was a literal no-op, one
-- claimed success without calling the backend at all. This adds a real
-- withdrawal-request flow: the customer/merchant/courier requests a payout,
-- the requested amount is debited from their in-app wallet immediately (so
-- it can't be spent twice), and an admin reviews + manually pays it out via
-- the existing Postman-driven admin API (there's no in-app admin UI, same
-- pattern as approvals/broadcasts/discount codes).

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'merchant', 'courier')),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
  admin_note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user ON withdrawal_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status, created_at DESC);

ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on withdrawal_requests" ON withdrawal_requests;
CREATE POLICY "Service role full access on withdrawal_requests"
  ON withdrawal_requests FOR ALL USING (true) WITH CHECK (true);
