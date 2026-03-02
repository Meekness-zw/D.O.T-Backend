import crypto from 'crypto';

/**
 * Create a Supabase-compatible access token JWT so the client can use it as Bearer token
 * and Supabase RLS will accept it. Must be signed with SUPABASE_JWT_SECRET (from Dashboard > API > JWT Secret).
 */
export function createSupabaseAccessToken({
  userId,
  phone,
  email = '',
  sessionId,
  supabaseUrl,
  jwtSecret,
  expiresInSeconds = 3600,
}) {
  if (!userId || !sessionId || !supabaseUrl || !jwtSecret) {
    throw new Error('createSupabaseAccessToken: missing required params');
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInSeconds;
  const iss = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;

  const payload = {
    iss,
    aud: 'authenticated',
    exp,
    iat: now,
    sub: userId,
    role: 'authenticated',
    aal: 'aal1',
    session_id: sessionId,
    email: email || '',
    phone: phone || '',
    is_anonymous: false,
    amr: [{ method: 'otp', timestamp: now }],
    app_metadata: { provider: 'phone', providers: ['phone'] },
    user_metadata: {},
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', jwtSecret)
    .update(signatureInput)
    .digest('base64url');

  return `${signatureInput}.${signature}`;
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

/**
 * Verify the access token (Bearer) and return payload with sub (userId).
 * Returns null if invalid or expired.
 */
export function verifyAccessToken(token, jwtSecret) {
  if (!token || !jwtSecret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [encodedHeader, encodedPayload, signature] = parts;
    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    const expected = crypto
      .createHmac('sha256', jwtSecret)
      .update(signatureInput)
      .digest('base64url');
    if (expected !== signature) return null;
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    );
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
