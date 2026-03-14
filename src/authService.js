import crypto from 'crypto';
import twilio from 'twilio';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { createSupabaseAccessToken } from './sessionToken.js';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const PASSWORD_SALT_ROUNDS = 10;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') return null;
  return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Start phone verification by sending a code via Twilio Verify (SMS).
 */
export async function sendOtpToPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone number must be a string');
  }
  if (!phone.startsWith('+') || phone.length < 10 || phone.length > 15) {
    throw new Error('Phone number must be in E.164 format (e.g. +263712345678)');
  }

  if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
    throw new Error(
      'Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID in .env'
    );
  }

  const verification = await twilioClient.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({
      to: phone,
      channel: 'sms',
    });

  console.log('[Auth] Twilio Verify sent OTP:', {
    phone,
    sid: verification.sid,
    status: verification.status,
    channel: verification.channel,
  });

  return { success: true, sid: verification.sid, status: verification.status };
}

/**
 * Verify the code with Twilio, then get or create the user in Supabase and return a session
 * so the client can authenticate seamlessly.
 *
 * For sign-up, a password is required; we hash it into Supabase Auth user_metadata.passwordHash.
 */
export async function verifyPhoneOtp({ phone, token, isSignUp = false, password }) {
  if (!phone || !token) {
    throw new Error('Phone and token are required');
  }
  if (typeof token !== 'string' || token.length !== 6 || !/^\d+$/.test(token)) {
    throw new Error('Verification code must be 6 digits');
  }

  if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
    throw new Error('Twilio Verify is not configured');
  }

  const check = await twilioClient.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({
      to: phone,
      code: token,
    });

  if (check.status !== 'approved' || !check.valid) {
    if (check.status === 'pending' || check.status === 'canceled') {
      throw new Error('Verification code has expired. Please request a new one.');
    }
    throw new Error('Invalid verification code. Please try again.');
  }

  if (!supabaseAdmin || !SUPABASE_URL || !SUPABASE_JWT_SECRET) {
    throw new Error(
      'Supabase admin or JWT secret not configured. Set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_JWT_SECRET in .env'
    );
  }

  // Check whether this phone already has a Supabase account
  const existingUser = await findSupabaseUserByPhone(phone);

  if (isSignUp) {
    if (!password || typeof password !== 'string' || password.length < 6) {
      throw new Error('Password is required for sign up and must be at least 6 characters');
    }
    // Sign-up: reject if an account already exists for this number
    if (existingUser) {
      throw new Error(
        'An account with this phone number already exists. Please sign in instead.'
      );
    }
  } else {
    // Sign-in: reject if no account exists yet
    if (!existingUser) {
      throw new Error(
        'No account found for this number. Please sign up first.'
      );
    }
  }

  // For sign-up, create the user (with password hash); for sign-in, return the found user.
  const user = existingUser ?? (await createSupabaseUserByPhone(phone, password));

  const sessionId = crypto.randomUUID();
  const accessToken = createSupabaseAccessToken({
    userId: user.id,
    phone: user.phone ?? phone,
    email: user.email ?? '',
    sessionId,
    supabaseUrl: SUPABASE_URL,
    jwtSecret: SUPABASE_JWT_SECRET,
    // 7 days session validity
    expiresInSeconds: 60 * 60 * 24 * 7,
  });

  return {
    user: {
      id: user.id,
      phone: user.phone ?? phone,
      email: user.email ?? null,
      user_metadata: user.user_metadata ?? {},
      app_metadata: user.app_metadata ?? {},
    },
    session: {
      access_token: accessToken,
      refresh_token: null,
      expires_in: 3600,
      token_type: 'bearer',
    },
  };
}

/**
 * Check if a phone number is already registered (exists in Supabase Auth).
 * Returns { registered: true, role } or { registered: false }. Role comes from user_profiles.
 */
export async function checkPhoneRegistered(phone) {
  if (!phone || typeof phone !== 'string') {
    return { registered: false };
  }
  const user = await findSupabaseUserByPhone(phone);
  if (!user) return { registered: false };
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  return { registered: true, role: profile?.role ?? null };
}

/**
 * Find an existing Supabase Auth user by phone. Returns the user or null.
 */
async function findSupabaseUserByPhone(phone) {
  const normalizePhone = (value) => (value || '').replace(/\D/g, '');
  const target = normalizePhone(phone);

  const { data: existing, error: listError } = await supabaseAdmin.auth.admin.listUsers({
    perPage: 1000,
  });

  if (listError) {
    console.error('Supabase listUsers error:', listError);
    return null;
  }

  return existing?.users?.find((u) => normalizePhone(u.phone) === target) ?? null;
}

/**
 * Create a new Supabase Auth user confirmed by phone. Returns the created user.
 */
async function createSupabaseUserByPhone(phone, password) {
  const normalizePhone = (value) => (value || '').replace(/\D/g, '');
  const target = normalizePhone(phone);

  const passwordHash = password ? await hashPassword(password) : null;

  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    phone,
    phone_confirm: true,
    user_metadata: passwordHash ? { passwordHash } : {},
  });

  if (createError) {
    const msg = createError.message?.toLowerCase() || '';
    const code = createError.code;
    // Race condition: another request already created the user – return it.
    if (msg.includes('already') || code === 'signup_duplicate_phone' || code === 'phone_exists') {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const match = list?.users?.find((u) => normalizePhone(u.phone) === target);
      if (match) return match;
    }
    console.error('Supabase createUser error:', createError);
    throw new Error(createError.message || 'Failed to create user');
  }

  return newUser.user;
}

/**
 * Password-based login for existing users.
 * No Twilio OTP is involved here: we look up the Supabase Auth user by phone,
 * verify the stored password hash (in user_metadata.passwordHash), and then
 * return a session token identical in shape to verifyPhoneOtp.
 */
export async function loginWithPassword({ phone, password }) {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone number is required');
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new Error('Password is required and must be at least 6 characters');
  }
  if (!phone.startsWith('+') || phone.length < 10 || phone.length > 15) {
    throw new Error('Phone number must be in E.164 format (e.g. +263712345678)');
  }

  if (!supabaseAdmin || !SUPABASE_URL || !SUPABASE_JWT_SECRET) {
    throw new Error(
      'Supabase admin or JWT secret not configured. Set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_JWT_SECRET in .env'
    );
  }

  const existingUser = await findSupabaseUserByPhone(phone);
  if (!existingUser) {
    throw new Error('No account found for this number. Please sign up first.');
  }

  const storedHash = existingUser.user_metadata?.passwordHash || null;
  const passwordOk = await verifyPassword(password, storedHash);
  if (!passwordOk) {
    throw new Error('Incorrect phone or password.');
  }

  // Optionally load role and full_name from user_profiles for convenience
  let profile = null;
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('full_name, role')
    .eq('id', existingUser.id)
    .maybeSingle();

  if (profileError) {
    console.error('Failed to load user profile during login:', profileError);
  } else {
    profile = profileData;
  }

  const sessionId = crypto.randomUUID();
  const accessToken = createSupabaseAccessToken({
    userId: existingUser.id,
    phone: existingUser.phone ?? phone,
    email: existingUser.email ?? '',
    sessionId,
    supabaseUrl: SUPABASE_URL,
    jwtSecret: SUPABASE_JWT_SECRET,
    // 7 days session validity
    expiresInSeconds: 60 * 60 * 24 * 7,
  });

  return {
    user: {
      id: existingUser.id,
      phone: existingUser.phone ?? phone,
      email: existingUser.email ?? null,
      role: profile?.role ?? null,
      full_name: profile?.full_name ?? null,
      user_metadata: existingUser.user_metadata ?? {},
      app_metadata: existingUser.app_metadata ?? {},
    },
    session: {
      access_token: accessToken,
      refresh_token: null,
      expires_in: 3600,
      token_type: 'bearer',
    },
  };
}

export async function getCurrentUser() {
  if (!supabaseAdmin) throw new Error('Admin client not configured');
  const { data, error } = await supabaseAdmin.auth.getUser();
  if (error) throw error;
  return data?.user ?? null;
}

export async function signOut() {
  if (!supabaseAdmin) return;
  await supabaseAdmin.auth.signOut();
}
