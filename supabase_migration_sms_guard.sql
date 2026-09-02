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

CREATE TABLE IF NOT EXISTS public.sms_send_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  ip TEXT,
  -- 'signup_otp' | 'password_reset' — so one abused flow can be traced.
  purpose TEXT NOT NULL,
  -- Null only after the provider accepts a message. Rate-limit refusals,
  -- configuration errors and provider failures use a diagnostic reason.
  blocked_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Repair installations that created the table from an earlier version.
UPDATE public.sms_send_log SET created_at = NOW() WHERE created_at IS NULL;
ALTER TABLE public.sms_send_log ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE public.sms_send_log ALTER COLUMN created_at SET NOT NULL;

-- Every guard query filters on a time window, and most also on phone or ip.
CREATE INDEX IF NOT EXISTS idx_sms_send_log_created ON public.sms_send_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_phone ON public.sms_send_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_ip ON public.sms_send_log(ip, created_at DESC);

ALTER TABLE public.sms_send_log ENABLE ROW LEVEL SECURITY;

-- Backend service-role only; nothing here may be reachable from a browser.
-- service_role bypasses RLS, so it does not need a permissive policy. The
-- previous policy omitted TO service_role and therefore applied to PUBLIC.
DROP POLICY IF EXISTS "Service role full access on sms_send_log" ON public.sms_send_log;
REVOKE ALL ON TABLE public.sms_send_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.sms_send_log TO service_role;

COMMENT ON TABLE public.sms_send_log IS
  'Outbound SMS outcomes. Null blocked_reason means the provider accepted the message; non-null rows are not counted toward send quotas.';
