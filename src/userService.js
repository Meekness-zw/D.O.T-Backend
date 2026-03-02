import { supabaseAdmin } from './supabaseAdminClient.js';

// Use admin client so server can upsert profiles regardless of RLS
const supabase = supabaseAdmin;
if (!supabase) {
  console.warn('[userService] supabaseAdmin not configured; ensure-profile may fail until SUPABASE_SERVICE_ROLE_KEY is set.');
}

/**
 * Ensures the user has a profile and a row in the correct role table.
 * Called after phone verification (sign-up and sign-in) with the role they selected.
 *
 * 1) user_profiles: id, email, phone, full_name, role (one row per user)
 * 2) Role table (one of):
 *    - customers: id (references user_profiles)
 *    - merchants: id, business_name (fullName or 'New Merchant')
 *    - couriers: id
 */
export async function ensureUserProfile({
  userId,
  email,
  phone,
  fullName,
  role // 'customer' | 'merchant' | 'courier'
}) {
  // Validate inputs
  if (!userId) {
    throw new Error('userId is required');
  }

  const validRoles = ['customer', 'merchant', 'courier'];
  if (!role || !validRoles.includes(role)) {
    throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
  }

  if (!supabase) {
    throw new Error('Server auth not configured (missing SUPABASE_SERVICE_ROLE_KEY)');
  }

  try {
    // Load existing profile so we don't wipe fields (name/email) on every login
    const { data: existingProfile, error: existingError } = await supabase
      .from('user_profiles')
      .select('email, phone, full_name, role')
      .eq('id', userId)
      .maybeSingle();

    if (existingError && existingError.code !== 'PGRST116') {
      console.error('Failed to read existing profile before upsert:', existingError);
      throw new Error(existingError.message || 'Failed to read existing profile');
    }

    const trimmedEmail = email && email.trim();
    const trimmedFullName = fullName && fullName.trim();

    // Derive a safe email value.
    // 1) If caller provided non-empty email, use it.
    // 2) Else, keep existing email if present.
    // 3) Else, generate a stable placeholder from phone or userId.
    const normalisedEmail =
      trimmedEmail ||
      existingProfile?.email ||
      (phone ? `${String(phone).replace(/\D/g, '')}@phone.local` : `${userId}@user.local`);

    const phoneToUse = phone || existingProfile?.phone || null;
    const fullNameToUse = trimmedFullName || existingProfile?.full_name || null;

    // 1) Upsert into user_profiles (preserving fields when not overridden)
    const { error: profileError } = await supabase.from('user_profiles').upsert(
      {
        id: userId,
        email: normalisedEmail,
        phone: phoneToUse,
        full_name: fullNameToUse,
        role
      },
      { onConflict: 'id' }
    );

    if (profileError) {
      console.error('Profile creation error:', profileError);
      throw new Error(`Failed to create user profile: ${profileError.message}`);
    }

    // 2) Create row in role-specific table if not exists
    let roleError;

    if (role === 'customer') {
      const { error } = await supabase.from('customers').upsert(
        { id: userId },
        { onConflict: 'id' }
      );
      roleError = error;
    } else if (role === 'merchant') {
      // Preserve existing business_name if no fullName provided
      let businessName = trimmedFullName || 'New Merchant';
      const { data: existingMerchant } = await supabase
        .from('merchants')
        .select('business_name')
        .eq('id', userId)
        .maybeSingle();
      if (existingMerchant?.business_name && !trimmedFullName) {
        businessName = existingMerchant.business_name;
      }

      const { error } = await supabase.from('merchants').upsert(
        {
          id: userId,
          business_name: businessName
        },
        { onConflict: 'id' }
      );
      roleError = error;
    } else if (role === 'courier') {
      const { error } = await supabase.from('couriers').upsert(
        { id: userId },
        { onConflict: 'id' }
      );
      roleError = error;
    }

    if (roleError) {
      console.error(`${role} table creation error:`, roleError);
      throw new Error(`Failed to create ${role} profile: ${roleError.message}`);
    }

    console.log(`✅ User profile created successfully for ${role}: ${userId}`);
    return true;
  } catch (error) {
    console.error('ensureUserProfile error:', error);
    throw error;
  }
}

const AVATARS_BUCKET = 'avatars'; // Create a public bucket "avatars" in Supabase Dashboard → Storage if missing.

/**
 * Get user profile from user_profiles by id.
 */
export async function getProfile(userId) {
  if (!userId || !supabase) {
    throw new Error('userId required and server must be configured');
  }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, full_name, email, phone, role, profile_photo, created_at, updated_at')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    throw new Error(error.message || 'Failed to fetch profile');
  }
  return data;
}

/**
 * Update user profile (full_name, email, profile_photo URL).
 * Does not update phone (use auth flow for that).
 */
export async function updateProfile(userId, updates) {
  if (!userId || !supabase) {
    throw new Error('userId required and server must be configured');
  }
  const allowed = {};
  if (updates.full_name !== undefined) allowed.full_name = updates.full_name || null;
  // Only update email when a non-empty value is provided; never write null (DB may have NOT NULL).
  if (updates.email !== undefined && updates.email != null && String(updates.email).trim())
    allowed.email = updates.email.trim();
  if (updates.profile_photo !== undefined) allowed.profile_photo = updates.profile_photo || null;
  if (Object.keys(allowed).length === 0) return await getProfile(userId);

  const { data, error } = await supabase
    .from('user_profiles')
    .update(allowed)
    .eq('id', userId)
    .select('id, full_name, email, phone, role, profile_photo, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message || 'Failed to update profile');
  return data;
}

/**
 * Upload profile photo to Supabase Storage and return public URL.
 * Caller should then call updateProfile(userId, { profile_photo: url }).
 */
export async function uploadProfilePhoto(userId, imageBuffer, contentType = 'image/jpeg') {
  if (!userId || !supabase) {
    throw new Error('userId required and server must be configured');
  }
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `${userId}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(path, imageBuffer, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    console.error('Profile photo upload error:', uploadError);
    throw new Error(uploadError.message || 'Failed to upload photo');
  }

  const { data: urlData } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(path);
  return urlData?.publicUrl || null;
}
