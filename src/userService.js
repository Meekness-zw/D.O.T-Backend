import { supabaseAdmin } from './supabaseAdminClient.js';

// Use admin client so server can upsert profiles regardless of RLS
const supabase = supabaseAdmin;
if (!supabase) {
  console.warn('[userService] supabaseAdmin not configured; ensure-profile may fail until SUPABASE_SERVICE_ROLE_KEY is set.');
}

/**
 * Get all roles for a user from user_roles. Falls back to profile.role if user_roles is empty.
 */
export async function getRoles(userId) {
  if (!userId || !supabase) return [];

  const uniqueRoles = (list) => {
    const out = [];
    for (const r of list) {
      if (r && !out.includes(r)) out.push(r);
    }
    return out;
  };

  // 1) Roles explicitly stored in user_roles (may be incomplete: e.g. only courier after
  // adding a second role — merchant might exist in merchants/stores but never got a row).
  let fromUserRoles = [];
  try {
    const { data: rows, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId);
    if (!error && Array.isArray(rows) && rows.length > 0) {
      fromUserRoles = rows.map((r) => r.role).filter(Boolean);
    }
  } catch (_) {
    fromUserRoles = [];
  }

  // 2) Always infer from role tables + stores so we never return only ['courier'] when
  // the same user also has a merchant row or owns a store.
  let inferred = [];
  try {
    const [
      { data: customerRow },
      { data: merchantRow },
      { data: courierRow },
      { data: storeRows },
    ] = await Promise.all([
      supabase.from('customers').select('id').eq('id', userId).maybeSingle(),
      supabase.from('merchants').select('id').eq('id', userId).maybeSingle(),
      supabase.from('couriers').select('id').eq('id', userId).maybeSingle(),
      supabase.from('stores').select('id').eq('merchant_id', userId).limit(1),
    ]);

    if (customerRow) inferred.push('customer');
    if (merchantRow) inferred.push('merchant');
    else if (Array.isArray(storeRows) && storeRows.length > 0) inferred.push('merchant');
    if (courierRow) inferred.push('courier');
  } catch (_) {
    inferred = [];
  }

  const merged = uniqueRoles([...fromUserRoles, ...inferred]);
  if (merged.length > 0) return merged;

  // Final fallback: use profile.role only.
  const profile = await getProfile(userId);
  return profile?.role ? [profile.role] : [];
}

/**
 * Keep user_roles aligned with customers / merchants / couriers / stores.
 * When courier is added, user_roles used to only get "courier" — merchant was missing even though
 * the merchants row + store still exist → login returned roles: [courier] and the app showed a false conflict.
 */
export async function syncUserRolesFromRoleTables(userId) {
  if (!userId || !supabase) return;
  try {
    const [{ data: customerRow }, { data: merchantRow }, { data: courierRow }, { data: storeRows }] =
      await Promise.all([
        supabase.from('customers').select('id').eq('id', userId).maybeSingle(),
        supabase.from('merchants').select('id').eq('id', userId).maybeSingle(),
        supabase.from('couriers').select('id').eq('id', userId).maybeSingle(),
        supabase.from('stores').select('id').eq('merchant_id', userId).limit(1),
      ]);
    const rolesToEnsure = [];
    if (customerRow) rolesToEnsure.push('customer');
    if (merchantRow || (Array.isArray(storeRows) && storeRows.length > 0)) rolesToEnsure.push('merchant');
    if (courierRow) rolesToEnsure.push('courier');
    for (const r of rolesToEnsure) {
      const { error } = await supabase
        .from('user_roles')
        .upsert({ user_id: userId, role: r }, { onConflict: 'user_id,role' });
      if (error) {
        console.warn(`syncUserRolesFromRoleTables upsert ${r}:`, error.message);
      }
    }
  } catch (e) {
    console.warn('syncUserRolesFromRoleTables:', e?.message || e);
  }
}

/**
 * Ensures the user has a profile and a row in the correct role table.
 * Supports multiple roles: adding a role does not remove existing roles or overwrite profile details.
 *
 * 1) user_profiles: id, email, phone, full_name, role (primary role; only set for new users)
 * 2) user_roles: add this role so user is listed under multiple roles
 * 3) Role table: ensure row in customers / merchants / couriers
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
    // Load existing profile so we don't wipe fields (name/email/role) on every login
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
    const normalisedEmail =
      trimmedEmail ||
      existingProfile?.email ||
      (phone ? `${String(phone).replace(/\D/g, '')}@phone.local` : `${userId}@user.local`);

    const phoneToUse = phone || existingProfile?.phone || null;
    const fullNameToUse = trimmedFullName || existingProfile?.full_name || null;

    // Primary role: only set for new users; existing users keep their primary role
    const primaryRole = existingProfile?.role ?? role;

    // 1) Upsert into user_profiles (preserve primary role when adding another role)
    const { error: profileError } = await supabase.from('user_profiles').upsert(
      {
        id: userId,
        email: normalisedEmail,
        phone: phoneToUse,
        full_name: fullNameToUse,
        role: primaryRole,
      },
      { onConflict: 'id' }
    );

    if (profileError) {
      console.error('Profile creation error:', profileError);
      throw new Error(`Failed to create user profile: ${profileError.message}`);
    }

    // 2) Add this role to user_roles (multi-role support; no-op if already present)
    const { error: roleInsertError } = await supabase
      .from('user_roles')
      .upsert({ user_id: userId, role }, { onConflict: 'user_id,role' });
    if (roleInsertError) {
      console.warn('user_roles insert warning (table may not exist yet):', roleInsertError.message);
    }

    // 3) Create row in role-specific table if not exists
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

    await syncUserRolesFromRoleTables(userId);

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

/**
 * When a courier updates their account profile photo, we also append a courier_documents row
 * so GET /users/me (getFullUserMe) picks courier_profile_photo_url from the latest document.
 */
export async function recordCourierProfilePhotoDocument(userId, documentUrl) {
  if (!userId || !documentUrl || !supabase) return;
  const roles = await getRoles(userId);
  if (!roles.includes('courier')) return;

  const { data: courierRow } = await supabase.from('couriers').select('id').eq('id', userId).maybeSingle();
  if (!courierRow?.id) return;

  const { error } = await supabase.from('courier_documents').insert({
    courier_id: userId,
    document_type: 'profile_photo',
    document_url: documentUrl,
    status: 'approved',
  });
  if (error) {
    console.error('recordCourierProfilePhotoDocument:', error.message || error);
  }
}
