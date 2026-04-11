import { supabase } from './supabaseClient.js';
import 'dotenv/config.js';
import { supabaseAdmin } from './supabaseAdminClient.js';

export async function sendOtpToPhone(phone) {
  console.log('[sendOtpToPhone] Sending OTP to:', phone);
  
  const { data, error } = await supabase.auth.signInWithOtp({
    phone,
    options: {
      channel: 'sms'
    }
  });

  console.log('[sendOtpToPhone] Response:', { data, error });

  if (error) throw error;
  return { message: 'OTP sent successfully' };
}

export async function verifyPhoneOtp({ phone, token }) {
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: 'sms'
  });

  if (error) throw error;
  return { user: data.user };
}

/**
 * Get the current authenticated user (if any).
 */
export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user;
}

/**
 * Sign out current user.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

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

  const { data: passwordMatch, error: passwordError } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('id', profile.id)
    .eq('password_hash', password)
    .single();

  if (passwordError || !passwordMatch) {
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