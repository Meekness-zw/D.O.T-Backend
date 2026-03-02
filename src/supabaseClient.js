import { createClient } from '@supabase/supabase-js';
import 'dotenv/config.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    '[supabaseClient] Missing SUPABASE_URL or SUPABASE_ANON_KEY. ' +
      'Set them in your environment (see backend/.env.example).'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Important for phone/Twilio auth flows in mobile apps
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});

