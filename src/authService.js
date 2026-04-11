import { supabase } from './supabaseClient.js';
import 'dotenv/config.js';

const DEXATEL_API_KEY = process.env.DEXATEL_API_KEY;
const DEXATEL_SENDER = process.env.DEXATEL_SENDER;

const otpStore = new Map();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSmsDexatel(phone, message) {
  const url = 'https://api.dexatel.com/sms/send';
  const data = new URLSearchParams({
    token: DEXATEL_API_KEY,
    sender: DEXATEL_SENDER,
    to: phone,
    message
  });
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data.toString()
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

