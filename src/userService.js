import { supabase } from './supabaseClient.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import crypto from 'crypto';

export async function getProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();
  
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getRoles(userId) {
  const roles = [];
  
  const [customer, merchant, courier] = await Promise.all([
    supabaseAdmin.from('customers').select('id').eq('id', userId).maybeSingle(),
    supabaseAdmin.from('merchants').select('id').eq('id', userId).maybeSingle(),
    supabaseAdmin.from('couriers').select('id').eq('id', userId).maybeSingle()
  ]);
  
  if (customer.data) roles.push('customer');
  if (merchant.data) roles.push('merchant');
  if (courier.data) roles.push('courier');
  
  return roles;
}

export async function updateProfile(userId, updates) {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

export async function uploadProfilePhoto(userId, buffer, contentType) {
  const fileName = `avatars/${userId}-${Date.now()}`;
  
  const { data, error } = await supabaseAdmin.storage
    .from('avatars')
    .upload(fileName, buffer, {
      contentType,
      upsert: true
    });
  
  if (error) throw error;
  
  const { data: urlData } = supabaseAdmin.storage
    .from('avatars')
    .getPublicUrl(fileName);
  
  return urlData.publicUrl;
}

export async function recordCourierProfilePhotoDocument(userId, photoUrl) {
  const { error } = await supabaseAdmin
    .from('courier_documents')
    .upsert({
      courier_id: userId,
      document_type: 'profile_photo',
      document_url: photoUrl,
      status: 'approved'
    }, { onConflict: 'courier_id,document_type' });
  
  if (error) throw error;
}

/**
 * After Supabase Auth creates a user in auth.users,
 * call this once to create the corresponding row in user_profiles
 * and the role-specific table (customer / merchant / courier).
 */
export async function ensureUserProfile({
  userId,
  email,
  phone,
  fullName,
  role,
  password
}) {
  const profileData = {
    id: userId,
    email,
    phone,
    full_name: fullName,
    role
  };

  if (password) {
    profileData.password_hash = crypto.createHash('sha256').update(password).digest('hex');
  }

  // 1) Upsert into user_profiles
  const { error: profileError } = await supabase.from('user_profiles').upsert(
    profileData,
    { onConflict: 'id' }
  );

  if (profileError) throw profileError;

  // 2) Create row in role-specific table if not exists
  if (role === 'customer') {
    await supabase.from('customers').upsert(
      { id: userId },
      { onConflict: 'id' }
    );
  } else if (role === 'merchant') {
    await supabase.from('merchants').upsert(
      {
        id: userId,
        business_name: fullName || 'New Merchant'
      },
      { onConflict: 'id' }
    );
  } else if (role === 'courier') {
    await supabase.from('couriers').upsert(
      { id: userId },
      { onConflict: 'id' }
    );
  }

  return true;
}

