import { supabase } from './supabaseClient.js';

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
  role // 'customer' | 'merchant' | 'courier'
}) {
  // 1) Upsert into user_profiles
  const { error: profileError } = await supabase.from('user_profiles').upsert(
    {
      id: userId,
      email,
      phone,
      full_name: fullName,
      role
    },
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

