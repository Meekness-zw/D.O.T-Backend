import { createClient } from '@supabase/supabase-js';
import 'dotenv/config.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '[supabaseAdminClient] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Required for Twilio Verify + Supabase auth flow.'
  );
}

/** Admin client for server-only operations (get/create user, ensure profile). Never expose to client. */
export const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;
