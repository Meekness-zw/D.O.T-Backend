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
    .select('id, password_hash')
    .eq('phone', phone)
    .single();

  if (profileError || !profile) {
    throw new Error('No account found with this phone number');
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

  return {
    registered: !!profile,
    userId: profile?.id || null,
    role: profile?.role || null
  };
}

export async function deleteUserById(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw error;
}
