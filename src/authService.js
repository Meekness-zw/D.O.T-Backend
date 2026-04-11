import crypto from 'crypto';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from './supabaseAdminClient.js';
import { createSupabaseAccessToken } from './sessionToken.js';
import { getRoles, syncUserRolesFromRoleTables } from './userService.js';

const DEXATEL_API_KEY = process.env.DEXATEL_API_KEY;
const DEXATEL_SENDER = process.env.DEXATEL_SENDER;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const PASSWORD_SALT_ROUNDS = 10;

// In-memory store mapping phone → { code, expiresAt }
// We generate the OTP ourselves and store it here until the user submits it.
const otpStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of otpStore.entries()) {
    if (entry.expiresAt < now) otpStore.delete(phone);
  }
}, 15 * 60 * 1000);

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') return null;
  return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Start phone verification by generating a 6-digit OTP and sending it via Dexatel SMS API.
 */
export async function sendOtpToPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone number must be a string');
  }
  if (!phone.startsWith('+') || phone.length < 10 || phone.length > 15) {
    throw new Error('Phone number must be in E.164 format (e.g. +263712345678)');
  }

  if (!DEXATEL_API_KEY || !DEXATEL_SENDER) {
    throw new Error('Dexatel is not configured. Set DEXATEL_API_KEY and DEXATEL_SENDER in .env');
  }

  // Generate a cryptographically random 6-digit code
  const code = String(crypto.randomInt(100000, 999999));

  // Dexatel expects the number without the leading +
  const dexPhone = phone.replace(/^\+/, '');

  try {
    await axios.post(
      'https://api.dexatel.com/v1/messages',
      {
        data: {
          from: DEXATEL_SENDER,
          to: [dexPhone],
          content: `Your Delivery On Time verification code is ${code}. Valid for 10 minutes. Do not share this code.`,
        },
      },
      {
        headers: {
          'X-auth-token': DEXATEL_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.message || err?.response?.data?.error || '';
    if (status === 400 || status === 422) {
      const userErr = new Error(
        msg || 'The phone number you entered is not valid. Please check and try again.'
      );
      userErr.isUserError = true;
      throw userErr;
    }
    if (status === 429) {
      const userErr = new Error('Too many verification attempts. Please wait a few minutes before trying again.');
      userErr.isUserError = true;
      throw userErr;
    }
    throw err;
  }

  // Store the code keyed by phone for later verification (10-minute TTL)
  otpStore.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

  console.log('[Auth] Dexatel OTP sent:', { phone });

  return { success: true };
}

/**
 * Verify the OTP locally (compared against what we stored when sending), then get or create
 * the user in Supabase and return a session so the client can authenticate seamlessly.
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

  const stored = otpStore.get(phone);
  if (!stored) {
    throw new Error('No pending verification found for this number. Please request a new code.');
  }
  if (stored.expiresAt < Date.now()) {
    otpStore.delete(phone);
    throw new Error('Verification code has expired. Please request a new one.');
  }

  if (stored.code !== token) {
    throw new Error('Invalid verification code. Please try again.');
  }

  // Code is consumed — remove from store
  otpStore.delete(phone);

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
 * No OTP is involved here: we look up the Supabase Auth user by phone,
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

  // Load profile and all roles (multi-role support)
  let profile = null;
  try {
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .select('full_name, role, is_suspended')
      .eq('id', existingUser.id)
      .maybeSingle();

    if (profileError) {
      // If is_suspended column not yet added, fall back to selecting without it
      const { data: fallback } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name, role')
        .eq('id', existingUser.id)
        .maybeSingle();
      profile = fallback;
    } else {
      profile = profileData;
    }
  } catch (e) {
    console.error('Failed to load user profile during login:', e);
  }

  // If the profile row is missing, the account was deleted — reject login
  if (!profile) {
    throw new Error('No account found for this number. Please sign up first.');
  }

  // If the account is suspended, reject login
  if (profile.is_suspended) {
    throw new Error('Your account has been suspended. Please contact support.');
  }

  // Repair user_roles from role tables (e.g. only "courier" was inserted when adding courier).
  await syncUserRolesFromRoleTables(existingUser.id);

  let roles = await getRoles(existingUser.id);

  // Belt-and-suspenders: guarantee merchant in roles[] if merchants row or store exists.
  try {
    if (supabaseAdmin && !roles.includes('merchant')) {
      const [{ data: merchantRow }, { data: storeRows }] = await Promise.all([
        supabaseAdmin.from('merchants').select('id').eq('id', existingUser.id).maybeSingle(),
        supabaseAdmin.from('stores').select('id').eq('merchant_id', existingUser.id).limit(1),
      ]);
      if (merchantRow || (Array.isArray(storeRows) && storeRows.length > 0)) {
        roles = [...roles, 'merchant'];
      }
    }
  } catch (e) {
    console.warn('loginWithPassword: merchant role expand:', e?.message || e);
  }
  roles = [...new Set(roles)];

  const primaryRole = profile?.role ?? (roles[0] ?? null);

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
      role: primaryRole,
      roles: roles.length > 0 ? roles : (primaryRole ? [primaryRole] : []),
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

/**
 * Permanently delete an auth user by id (service role only).
 * Supabase will remove the auth.users row; ensure DB FKs (e.g. user_profiles.id -> auth.users.id ON DELETE CASCADE) so profile/role data is removed.
 */
export async function deleteUserById(userId) {
  if (!userId) throw new Error('User id is required');
  if (!supabaseAdmin) throw new Error('Admin client not configured');
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('deleteUserById error:', error);
    throw new Error(error.message || 'Failed to delete account');
  }
}
