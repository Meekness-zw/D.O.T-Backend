import 'dotenv/config.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createSupabaseAccessToken } from './sessionToken.js';

function toPhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildPhoneCandidates(phone) {
  const normalised = String(phone || '').replace(/[\s\-().]/g, '').replace(/^\+?/, '+');
  const digits = toPhoneDigits(normalised);
  const candidates = new Set([normalised, digits]);

  // Zimbabwe local format fallback for legacy rows like 07xxxxxxxx.
  if (digits.startsWith('263') && digits.length > 3) {
    candidates.add(`0${digits.slice(3)}`);
  }
  if (digits.startsWith('0') && digits.length > 1) {
    candidates.add(`+263${digits.slice(1)}`);
    candidates.add(`263${digits.slice(1)}`);
  }

  return { normalised, digits, candidates: Array.from(candidates).filter(Boolean) };
}

export async function loginWithPassword({ phone, password }) {
  if (!phone || !password) {
    throw new Error('Phone and password are required');
  }

  // Normalise: strip spaces/dashes and ensure leading + so "+263 71 234 5678" matches "+263712345678"
  const { normalised, digits, candidates } = buildPhoneCandidates(phone);
  let profile = null;

  const { data: exactProfile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, phone, email, full_name, role, password_hash, is_suspended')
    .eq('phone', normalised)
    .single();

  if (!profileError && exactProfile) {
    profile = exactProfile;
  } else {
    const { data: fallbackProfiles, error: fallbackError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, phone, email, full_name, role, password_hash, is_suspended')
      .in('phone', candidates)
      .limit(5);

    if (fallbackError) throw fallbackError;

    profile = (fallbackProfiles || []).find((p) => toPhoneDigits(p.phone) === digits) || null;
  }

  if (!profile) {
    throw new Error('No account found with this phone number');
  }

  if (profile.is_suspended) {
    throw new Error('Your account has been suspended. Please contact support.');
  }

  const inputHash = crypto.createHash('sha256').update(password).digest('hex');

  if (profile.password_hash !== inputHash) {
    throw new Error('Incorrect phone or password');
  }

  const accessTokenTtlSeconds = 60 * 60 * 24 * 3650; // 10 years
  const accessToken = createSupabaseAccessToken({
    userId: profile.id,
    phone: profile.phone || normalised,
    email: profile.email || '',
    sessionId: randomUUID(),
    supabaseUrl: process.env.SUPABASE_URL,
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
    expiresInSeconds: accessTokenTtlSeconds,
  });

  return {
    user: {
      id: profile.id,
      phone: profile.phone || normalised,
      email: profile.email || null,
      full_name: profile.full_name || null,
      role: profile.role || null,
    },
    session: {
      access_token: accessToken,
      refresh_token: null,
      token_type: 'bearer',
      expires_in: accessTokenTtlSeconds,
    },
  };
}

export async function checkPhoneRegistered(phone) {
  const normalised = phone
    ? phone.replace(/[\s\-().]/g, '').replace(/^\+?/, '+')
    : phone;

  const { data: profile, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, role')
    .eq('phone', normalised)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return {
    registered: !!profile,
    userId: profile?.id || null,
    role: profile?.role || null,
    phone: normalised,
  };
}

export async function deleteUserById(userId) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw error;
}
