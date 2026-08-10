import { supabaseAdmin } from './supabaseAdminClient.js';

const supabase = supabaseAdmin;

/**
 * Current balance for ONE role's wallet. A single account can hold multiple
 * roles (customer + merchant + courier are all the same user_id) — their
 * balances are kept fully separate and never combined, so every balance
 * read/write across the app must go through this (scoped by user_type),
 * never a bare "latest transaction for this user_id" query.
 */
export async function getWalletBalance(userId, userType) {
  if (!supabase || !userId || !userType) return 0;
  const { data } = await supabase
    .from('wallet_transactions')
    .select('balance_after')
    .eq('user_id', userId)
    .eq('user_type', userType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.balance_after) || 0;
}

/** Balances for several of a user's roles at once, as { customer, merchant, courier } (only the requested keys are included). */
export async function getWalletBalances(userId, roles) {
  const result = {};
  await Promise.all(
    (roles || []).map(async (role) => {
      result[role] = await getWalletBalance(userId, role);
    }),
  );
  return result;
}
