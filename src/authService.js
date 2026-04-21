import { supabase } from './supabaseClient.js';
import 'dotenv/config.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import crypto from 'crypto';

export async function loginWithPassword({ phone, password }) {
  if (!phone || !password) {
    throw new Error('Phone and password are required');
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, password_hash, is_suspended')
    .eq('phone', phone)
    .single();

  if (profileError || !profile) {
    throw new Error('No account found with this phone number');
  }

  if (profile.is_suspended) {
    throw new Error('Your account has been suspended. Please contact support.');
  }

  const inputHash = crypto.createHash('sha256').update(password).digest('hex');

  if (profile.password_hash !== inputHash) {
    throw new Error('Incorrect phone or password');
  }

  const { data: session, error: sessionError } = await supabase.auth.signInWithPassword({
    phone,
    password
  });

  if (sessionError) throw sessionError;
  return session;
}

export async function checkPhoneRegistered(phone) {
  const { data: profile, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, role')
    .eq('phone', phone)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  if (profile) {
    return { registered: true, userId: profile.id, role: profile.role || null };
  }

  // Profile not found — check auth.users directly so callers can reuse the
  // existing auth record instead of hitting a phone_exists conflict.
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceKey) {
    try {
      const url = `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(`phone=${phone}`)}&per_page=1`;
      const res = await fetch(url, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (res.ok) {
        const body = await res.json();
        const users = Array.isArray(body?.users) ? body.users : [];
        if (users.length > 0) {
          // Auth user exists but profile was deleted — treat as registered so
          // verify-otp reuses the existing auth ID and recreates the profile.
          return { registered: true, userId: users[0].id, role: null };
        }
      }
    } catch (_) { /* ignore — fall through to not-registered */ }
  }

  return { registered: false, userId: null, role: null };
}

export async function deleteUserById(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw error;
}
