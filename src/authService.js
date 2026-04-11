import { supabase } from './supabaseClient.js';

/**
 * Start phone signup/login by sending an OTP SMS.
 * Twilio is configured inside Supabase Auth; from the app we just call this.
 */
export async function sendOtpToPhone(phone) {
  // phone must be in E.164 format, e.g. +2637xxxxxxx
  const { data, error } = await supabase.auth.signInWithOtp({
    phone,
    options: {
      channel: 'sms'
    }
  });

  if (error) throw error;
  return data;
}

/**
 * Verify the OTP sent to the user's phone and complete sign-in.
 * On success, you get a user session back.
 */
export async function verifyPhoneOtp({ phone, token }) {
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: 'sms'
  });

  if (error) throw error;
  return data;
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

