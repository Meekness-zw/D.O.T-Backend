-- Run in Supabase SQL Editor.
--
-- Durable spend guard for outbound SMS.
--
-- The existing express-rate-limit guard keys on IP **and** phone together, so
-- it only ever caps one address hammering one number. A script walking ten
-- thousand different numbers from a single address gets the full allowance for
-- every one of them and never trips the limit, and because the counters live
-- in process memory, each deploy or Render spin-down wipes them anyway.
--
-- That is the shape of an SMS pumping attack: the numbers belong to the
-- attacker on premium ranges, and they collect a share of what each message
-- costs to deliver. The bill is capped only by how fast requests can be sent.
--
-- Every send is recorded here so the caps can be counted over real time
-- windows and survive a restart.

CREATE TABLE IF NOT EXISTS sms_send_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  ip TEXT,
  -- 'signup_otp' | 'password_reset' — so one abused flow can be traced.
  purpose TEXT NOT NULL,
  -- Set when the send was refused, naming the cap that stopped it. Refusals
  -- are logged too: a wall of them is what an attack looks like from here.
  blocked_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Every guard query filters on a time window, and most also on phone or ip.
CREATE INDEX IF NOT EXISTS idx_sms_send_log_created ON sms_send_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_phone ON sms_send_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_ip ON sms_send_log(ip, created_at DESC);

ALTER TABLE sms_send_log ENABLE ROW LEVEL SECURITY;

-- Backend service-role only; nothing here should be reachable from a browser.
DROP POLICY IF EXISTS "Service role full access on sms_send_log" ON sms_send_log;
CREATE POLICY "Service role full access on sms_send_log"
  ON sms_send_log FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE sms_send_log IS
  'Every outbound SMS attempt, sent or refused. Backs the spend caps in src/smsGuard.js.';
