import { supabase } from './supabaseClient.js';
import 'dotenv/config.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import crypto from 'crypto';

export async function sendOtpToPhone(phone) {
  console.log('[sendOtpToPhone] Sending OTP to:', phone);

  const { data, error } = await supabase.auth.signInWithOtp({
    phone,
    options: { channel: 'sms' }
  });

  console.log('[sendOtpToPhone] Response:', { data, error });

  if (error) throw error;
  return { message: 'OTP sent successfully' };
}

/**
 * Sign-up path: create the user with their password and send the OTP in one step.
 * Using signUp (not signInWithOtp) means the password is set at creation time, so
 * verifyOtp later just confirms the code and returns a session — no admin update needed.
 */
export async function sendSignUpOtp({ phone, password }) {
  console.log('[sendSignUpOtp] Registering and sending OTP to:', phone);

  const { data, error } = await supabase.auth.signUp({
    phone,
    password,
    options: { channel: 'sms' }
  });

  console.log('[sendSignUpOtp] Response:', { data, error });

  if (error) throw error;
  return { message: 'OTP sent successfully' };
}

export async function verifyPhoneOtp({ phone, token, isSignUp = false, password, confirmPassword }) {
  if (isSignUp) {
    if (!password) throw new Error('Password required for sign up');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (password !== confirmPassword) throw new Error('Passwords do not match');
  }

  // For both sign-up and sign-in: verify the OTP and get a session.
  // For sign-up the user was already created (with password) during send-otp via signUp(),
  // so no admin password update is needed and the session returned here is valid.
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: 'sms'
  });

  if (error) throw error;
  return { user: data.user, session: data.session };
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