/** Ensure the parent row exists before inserting a courier. Never trust client identity fields. */
export async function ensureCourierAccountProfile(client, userId, fullName) {
  const { data: profile, error: readError } = await client
    .from('user_profiles').select('id').eq('id', userId).maybeSingle();
  if (readError) throw readError;
  if (profile) return;

  // A valid session can outlive a missing application profile. Recover only
  // from the server's Auth record for the authenticated ID, never a new UUID.
  const { data, error: authError } = await client.auth.admin.getUserById(userId);
  if (authError || !data?.user || data.user.id !== userId) {
    throw new Error('Your account could not be linked. Please sign in again or contact support.');
  }
  const user = data.user;
  const { error } = await client.from('user_profiles').upsert({
    id: userId,
    email: user.email || null,
    phone: user.phone ? `+${user.phone.replace(/\D/g, '')}` : null,
    full_name: fullName,
    role: 'courier',
  }, { onConflict: 'id', ignoreDuplicates: true });
  // Do not overwrite an existing account if another request repaired it first.
  if (error) throw error;
}
