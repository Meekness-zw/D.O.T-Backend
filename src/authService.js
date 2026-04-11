import { supabase } from './supabaseClient.js';
import 'dotenv/config.js';
import { supabaseAdmin } from './supabaseAdminClient.js';

const DEXATEL_API_KEY = process.env.DEXATEL_API_KEY;
const DEXATEL_SENDER = process.env.DEXATEL_SENDER;

const otpStore = new Map();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSmsDexatel(phone, message) {
  if (!DEXATEL_API_KEY || !DEXATEL_SENDER) {
    throw new Error('Dexatel API not configured. Check DEXATEL_API_KEY and DEXATEL_SENDER in .env');
  }
  
  const url = 'https://api.dexatel.com/v1/messages';
  
  const phoneNumber = phone.startsWith('+') ? phone.substring(1) : phone;
  
  const payload = {
    channel: 'SMS',
    from: DEXATEL_SENDER,
    to: phoneNumber,
    text: message
  };
  
  console.log('Dexatel request:', JSON.stringify(payload));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dexatel-Key': DEXATEL_API_KEY
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dexatel SMS failed: ${errorText}`);
  }
  
  return response.json();
}

export async function sendOtpToPhone(phone) {
  const otp = generateOtp();
  otpStore.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });
  
  await sendSmsDexatel(phone, `Your OTP is: ${otp}`);
  return { message: 'OTP sent successfully' };
}

export async function verifyPhoneOtp({ phone, token }) {
  const stored = otpStore.get(phone);
  
  if (!stored) {
    throw new Error('No OTP requested for this phone');
  }
  
  if (Date.now() > stored.expires) {
    otpStore.delete(phone);
    throw new Error('OTP expired');
  }
  
  if (stored.otp !== token) {
    throw new Error('Invalid OTP');
  }
  
  otpStore.delete(phone);
  
  return { user: { phone } };
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

