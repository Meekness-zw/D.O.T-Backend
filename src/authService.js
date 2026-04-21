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
  // Supabase stores phones without '+', so compare digits only.
  try {
    const digitsOnly = (p) => (p || '').replace(/\D/g, '');
    const target = digitsOnly(phone);
    let page = 1;
    while (target) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      const users = Array.isArray(data?.users) ? data.users : [];
      const match = users.find(u => digitsOnly(u.phone) === target);
      if (match) {
        // Auth user exists but profile was deleted — reuse the auth ID so
        // verify-otp can recreate the profile without hitting phone_exists.
        return { registered: true, userId: match.id, role: null };
      }
      if (users.length < 1000) break;
      page++;
    }
  } catch (_) { /* ignore — fall through */ }

  return { registered: false, userId: null, role: null };
}

export async function deleteUserById(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw error;
}
