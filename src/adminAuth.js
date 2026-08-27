/**
 * Per-admin accounts with TOTP two-factor for the dashboard.
 *
 * Replaces three shared role API keys where the key WAS the credential:
 * whoever held it had that role forever, and nothing recorded who acted.
 * Here each person has an account, an authenticator seed, a session that
 * expires, and an attributable audit trail.
 *
 * The old env keys keep working while `admin_users` is empty so that
 * deploying this cannot lock anyone out. As soon as the first account
 * exists they stop granting dashboard access — otherwise a leaked key
 * would simply bypass the second factor and none of this would mean
 * anything.
 */
import crypto from 'crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin, generateSecret } from 'otplib';
import { hashPassword, verifyPassword } from './passwordHash.js';
import { assertStrongPassword } from './passwordPolicy.js';
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';

export const DASHBOARD_ROLES = ['admin', 'accountant', 'sales_marketing'];

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // full session, after both factors
const MFA_WINDOW_MS = 5 * 60 * 1000;          // password done, TOTP outstanding
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const TOTP_ISSUER = 'Delivery On Time';

// Session tokens carry a prefix so the middleware can tell them from a
// legacy env key without a database round trip on every request.
const SESSION_PREFIX = 'dot_sess_';

const totp = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
  digits: 6,
  period: 30,
  algorithm: 'sha1',
});

// One step either side of now, i.e. ±30s, absorbing clock drift between the
// phone and the server. Wider windows multiply the guess space for free.
const TOTP_DRIFT_STEPS = 1;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newToken() {
  return SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Constant-time compare that tolerates unequal lengths without leaking them. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

// ─── Legacy env keys ────────────────────────────────────────────────────────

function legacyRoleForKey(headerKey) {
  if (!headerKey) return null;
  const configured = [
    ['admin', process.env.ADMIN_API_KEY],
    ['accountant', process.env.ACCOUNTANT_API_KEY],
    ['sales_marketing', process.env.SALES_MARKETING_API_KEY],
  ];
  const matches = configured.filter(([, key]) => key && safeEqual(headerKey, key));
  // Fail closed if two roles were accidentally given the same key.
  return matches.length === 1 ? matches[0][0] : null;
}

// Whether any admin account exists. Latches to true and is never re-checked
// after that: the answer only ever goes false again if every account is
// deleted, and re-enabling the env-key fallback automatically on that basis
// would turn "someone dropped the table" into "the bypass is back on".
let accountsExist = false;
let accountsCheckedAt = 0;
const ACCOUNTS_RECHECK_MS = 15 * 1000;

export async function adminAccountsExist() {
  if (accountsExist) return true;
  if (Date.now() - accountsCheckedAt < ACCOUNTS_RECHECK_MS) return false;
  accountsCheckedAt = Date.now();
  if (!supabase) return false;
  const { count, error } = await supabase
    .from('admin_users')
    .select('id', { count: 'exact', head: true });
  // A failed probe must not silently re-open the env-key path.
  if (error) throw new Error(error.message || 'Failed to check admin accounts');
  if ((count || 0) > 0) accountsExist = true;
  return accountsExist;
}

// ─── Audit trail ────────────────────────────────────────────────────────────

export async function logAdminAction({ req, user, action, detail = null }) {
  if (!supabase) return;
  try {
    await supabase.from('admin_audit_log').insert({
      admin_user_id: user?.id || null,
      username: user?.username || null,
      role: user?.role || null,
      action,
      method: req?.method || null,
      path: req?.path || null,
      ip: req ? clientIp(req) : null,
      detail,
    });
  } catch (err) {
    // Never fail the request because the log write failed.
    console.error('admin audit log write failed:', err?.message || err);
  }
}

// ─── Lockout ────────────────────────────────────────────────────────────────

function isLocked(user) {
  return !!(user.locked_until && new Date(user.locked_until).getTime() > Date.now());
}

async function registerFailure(user) {
  const attempts = (user.failed_attempts || 0) + 1;
  const patch = { failed_attempts: attempts };
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    patch.locked_until = new Date(Date.now() + LOCKOUT_MS).toISOString();
    patch.failed_attempts = 0;
  }
  await supabase.from('admin_users').update(patch).eq('id', user.id);
  return attempts >= MAX_FAILED_ATTEMPTS;
}

async function clearFailures(user) {
  await supabase
    .from('admin_users')
    .update({ failed_attempts: 0, locked_until: null })
    .eq('id', user.id);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

async function createSession({ user, req, mfaPending }) {
  const token = newToken();
  const ttl = mfaPending ? MFA_WINDOW_MS : SESSION_TTL_MS;
  const { error } = await supabase.from('admin_sessions').insert({
    admin_user_id: user.id,
    token_hash: sha256(token),
    mfa_pending: mfaPending,
    expires_at: new Date(Date.now() + ttl).toISOString(),
    ip: clientIp(req),
    user_agent: req.headers['user-agent'] || null,
  });
  if (error) throw new Error(error.message || 'Failed to create session');
  return token;
}

async function loadSession(token) {
  if (!token || !token.startsWith(SESSION_PREFIX)) return null;
  const { data, error } = await supabase
    .from('admin_sessions')
    .select('id, admin_user_id, mfa_pending, expires_at, revoked_at, admin_users ( id, username, full_name, role, is_active, totp_secret, totp_enrolled_at, must_change_password )')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load session');
  if (!data) return null;
  if (data.revoked_at) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  if (!data.admin_users || data.admin_users.is_active === false) return null;
  return { ...data, user: data.admin_users };
}

async function promoteSession(sessionId) {
  const { error } = await supabase
    .from('admin_sessions')
    .update({
      mfa_pending: false,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw new Error(error.message || 'Failed to promote session');
}

export async function revokeSession(token) {
  if (!supabase || !token?.startsWith(SESSION_PREFIX)) return;
  await supabase
    .from('admin_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', sha256(token));
}

async function revokeAllSessionsFor(adminUserId) {
  await supabase
    .from('admin_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('admin_user_id', adminUserId)
    .is('revoked_at', null);
}

// ─── TOTP + recovery codes ──────────────────────────────────────────────────

export function buildOtpauthUri(username, secret) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function totpMatches(secret, code) {
  const cleaned = String(code || '').replace(/\D/g, '');
  if (cleaned.length !== 6) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let step = -TOTP_DRIFT_STEPS; step <= TOTP_DRIFT_STEPS; step += 1) {
    const expected = await totp.generate({ secret, epoch: now + step * 30 });
    if (safeEqual(cleaned, expected)) return true;
  }
  return false;
}

function generateRecoveryCodes() {
  // Crockford-ish base32 without look-alike characters, so a code read off
  // paper under pressure does not fail on O/0 or I/1.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const bytes = crypto.randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j += 1) code += alphabet[bytes[j] % alphabet.length];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

async function issueRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  await supabase.from('admin_recovery_codes').delete().eq('admin_user_id', userId);
  const { error } = await supabase.from('admin_recovery_codes').insert(
    codes.map((code) => ({ admin_user_id: userId, code_hash: sha256(code) })),
  );
  if (error) throw new Error(error.message || 'Failed to store recovery codes');
  return codes;
}

/** Consumes a recovery code. Returns true only if it was unused and matched. */
async function consumeRecoveryCode(userId, submitted) {
  const cleaned = String(submitted || '').trim().toUpperCase();
  if (!cleaned) return false;
  const { data, error } = await supabase
    .from('admin_recovery_codes')
    .select('id')
    .eq('admin_user_id', userId)
    .eq('code_hash', sha256(cleaned))
    .is('used_at', null)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to check recovery code');
  if (!data) return false;
  // Guarded by `used_at IS NULL` so two concurrent submissions of the same
  // code cannot both succeed.
  const { data: claimed, error: claimError } = await supabase
    .from('admin_recovery_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(claimError.message || 'Failed to consume recovery code');
  return !!claimed;
}

// ─── Role permissions ───────────────────────────────────────────────────────

export const DASHBOARD_SECTIONS = {
  admin: ['overview', 'users', 'orders', 'deliveries', 'merchants', 'couriers', 'stores', 'payments', 'discounts', 'approvals', 'quickbooks', 'admins'],
  accountant: ['overview', 'users', 'orders', 'deliveries', 'merchants', 'couriers', 'payments', 'quickbooks'],
  sales_marketing: ['overview', 'users', 'merchants', 'stores', 'discounts'],
};

export function dashboardRoleCanAccess(role, method, path) {
  // Every signed-in admin may read their own session and manage their own
  // credentials; those are not role-gated.
  if (path === '/admin/session' || path.startsWith('/admin/auth/')) return true;
  // Account administration and the audit trail are admin-only, regardless of
  // the blanket admin allowance below.
  if (path.startsWith('/admin/admins') || path.startsWith('/admin/audit-log')) {
    return role === 'admin';
  }
  if (role === 'admin') return true;
  const readOnly = method === 'GET';
  if (role === 'accountant') {
    // Accountant manages the QuickBooks connection (connect/disconnect/mappings/backfill) in
    // addition to the usual read-only financial views.
    if (path.startsWith('/admin/quickbooks')) return true;
    // Accountants can inspect registered customers, merchants, and couriers,
    // but approval and user-management actions remain admin-only.
    if (path === '/admin/users/pending') return false;
    return readOnly && [
      '/admin/stats', '/admin/users', '/admin/orders', '/admin/deliveries',
      '/admin/payments', '/admin/merchants', '/admin/couriers',
      '/admin/payout-details', '/admin/withdrawals',
    ].some((prefix) => path.startsWith(prefix));
  }
  if (role === 'sales_marketing') {
    if (path.startsWith('/admin/discount-codes')) return true;
    if (path.startsWith('/admin/products/') || /^\/admin\/stores\/[^/]+\/products(?:\/upload-image)?$/.test(path)) {
      return true;
    }
    if (!readOnly) return false;
    if (path === '/admin/users/pending') return false;
    return [
      '/admin/stats', '/admin/users', '/admin/merchants', '/admin/stores',
    ].some((prefix) => path.startsWith(prefix));
  }
  return false;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    isActive: user.is_active !== false,
    twoFactorEnrolled: !!user.totp_enrolled_at,
    mustChangePassword: !!user.must_change_password,
    lastLoginAt: user.last_login_at || null,
    createdAt: user.created_at || null,
  };
}

// ─── Middleware ─────────────────────────────────────────────────────────────

function presentedCredential(req) {
  const header = req.headers['x-admin-key'];
  if (header) return String(header);
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Authenticates the dashboard caller and enforces their role.
 *
 * Accepts a session token from the two-factor login. Also accepts the legacy
 * env API keys, but ONLY while no admin account exists — once one does, a
 * bare key would be a way around the second factor.
 */
export async function requireAdmin(req, res, next) {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Server not configured', details: 'Supabase credentials missing' });
    }
    const presented = presentedCredential(req);
    if (!presented) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Sign in to the dashboard' });
    }

    if (presented.startsWith(SESSION_PREFIX)) {
      const session = await loadSession(presented);
      if (!session) {
        return res.status(401).json({ error: 'Unauthorized', details: 'Your session has expired. Please sign in again.' });
      }
      if (session.mfa_pending) {
        return res.status(401).json({ error: 'Unauthorized', details: 'Two-factor verification required' });
      }
      const user = session.user;
      // A forced password change must not be side-steppable by calling the
      // API directly while the dashboard shows the change-password screen.
      if (user.must_change_password && !req.path.startsWith('/admin/auth/') && req.path !== '/admin/session') {
        return res.status(403).json({ error: 'Password change required', details: 'Set a new password before continuing' });
      }
      if (!dashboardRoleCanAccess(user.role, req.method, req.path)) {
        return res.status(403).json({ error: 'Forbidden', details: 'This account does not have access to that dashboard function' });
      }
      req.adminUser = user;
      req.dashboardRole = user.role;
      req.adminSessionId = session.id;
      req.adminSessionToken = presented;
      if (req.method !== 'GET') {
        logAdminAction({ req, user, action: `${req.method} ${req.path}` });
      }
      return next();
    }

    if (await adminAccountsExist()) {
      return res.status(401).json({
        error: 'Unauthorized',
        details: 'Dashboard API keys have been replaced by per-admin accounts. Sign in with your username, password and authenticator code.',
      });
    }

    // Pre-migration fallback: no accounts exist yet, so the env keys still work.
    const role = legacyRoleForKey(presented);
    if (!role) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Valid dashboard credentials required' });
    }
    if (!dashboardRoleCanAccess(role, req.method, req.path)) {
      return res.status(403).json({ error: 'Forbidden', details: 'This account does not have access to that dashboard function' });
    }
    req.dashboardRole = role;
    req.legacyKeyAuth = true;
    return next();
  } catch (error) {
    console.error('requireAdmin error:', error);
    return res.status(500).json({ error: 'Authentication failed', details: 'Please try again later' });
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Keyed by IP + username so one attacker cannot lock a colleague out by
// spamming their name, while still capping attempts per name per IP.
function authLimiter({ max, windowMinutes, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const who = String(req.body?.username || '').trim().toLowerCase();
      return `${ipKeyGenerator(req)}:${who || 'anon'}`;
    },
    handler: (req, res) => res.status(429).json({ error: 'Too many attempts', details: message }),
  });
}

export function registerAdminAuthRoutes(app) {
  const loginLimiter = authLimiter({
    max: 10, windowMinutes: 15,
    message: 'Too many sign-in attempts. Please try again in 15 minutes.',
  });
  // Tighter than the password step: six digits is a small guess space, and
  // the caller already holds a valid mfa token by this point.
  const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req),
    handler: (req, res) => res.status(429).json({ error: 'Too many attempts', details: 'Too many codes tried. Please wait 15 minutes.' }),
  });

  /**
   * POST /admin/auth/bootstrap — create the first admin account.
   * Requires ADMIN_API_KEY. Allowed only while no account exists, unless
   * ADMIN_BOOTSTRAP_ENABLED is explicitly set, which is the documented
   * break-glass for a total loss of authenticators.
   */
  app.post('/admin/auth/bootstrap', loginLimiter, async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Server not configured' });
      const key = presentedCredential(req);
      if (!process.env.ADMIN_API_KEY || !key || !safeEqual(key, process.env.ADMIN_API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized', details: 'Valid ADMIN_API_KEY required' });
      }
      const breakGlass = process.env.ADMIN_BOOTSTRAP_ENABLED === 'true';
      if (await adminAccountsExist() && !breakGlass) {
        return res.status(409).json({
          error: 'Already set up',
          details: 'Admin accounts exist. Set ADMIN_BOOTSTRAP_ENABLED=true to force a recovery account.',
        });
      }

      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const fullName = String(req.body?.full_name || '').trim() || null;
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return res.status(400).json({ error: 'Invalid username', details: '3-32 characters: letters, numbers, dot, dash or underscore' });
      }
      const strength = await assertStrongPassword(password);
      if (!strength.valid) return res.status(400).json({ error: strength.error });

      const { data, error } = await supabase
        .from('admin_users')
        .insert({
          username,
          full_name: fullName,
          password_hash: hashPassword(password),
          role: 'admin',
          // The bootstrapper chose this password themselves, so there is
          // nothing to force them to change.
          must_change_password: false,
        })
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That username is taken' });
        throw new Error(error.message || 'Failed to create admin account');
      }
      accountsExist = true;
      await logAdminAction({ req, user: data, action: 'admin.bootstrap' });
      return res.status(201).json({
        admin: publicUser(data),
        next: 'Sign in with this username and password to enroll your authenticator.',
      });
    } catch (error) {
      console.error('post /admin/auth/bootstrap error:', error);
      return res.status(500).json({ error: 'Bootstrap failed', details: error.message || 'Please try again later' });
    }
  });

  /** POST /admin/auth/login — first factor. Never reveals whether a name exists. */
  app.post('/admin/auth/login', loginLimiter, async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Server not configured' });
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return res.status(400).json({ error: 'Enter your username and password' });
      }

      const { data: user, error } = await supabase
        .from('admin_users')
        .select('*')
        .ilike('username', username)
        .maybeSingle();
      if (error) throw new Error(error.message || 'Failed to look up account');

      const invalid = { error: 'Invalid credentials', details: 'Check your username and password.' };
      if (!user || user.is_active === false) {
        // Spend comparable time on a miss so response timing does not
        // disclose which usernames are real.
        verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
        return res.status(401).json(invalid);
      }
      if (isLocked(user)) {
        return res.status(423).json({
          error: 'Account locked',
          details: `Too many failed attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`,
        });
      }

      const check = verifyPassword(password, user.password_hash);
      if (!check.valid) {
        const nowLocked = await registerFailure(user);
        await logAdminAction({ req, user, action: 'admin.login.failed' });
        return res.status(nowLocked ? 423 : 401).json(nowLocked
          ? { error: 'Account locked', details: 'Too many failed attempts. Try again in 15 minutes.' }
          : invalid);
      }
      if (check.needsRehash) {
        await supabase.from('admin_users').update({ password_hash: hashPassword(password) }).eq('id', user.id);
      }
      await clearFailures(user);

      // Password is right; issue a token that proves ONLY that, and which
      // every dashboard endpoint refuses until the code is verified.
      const mfaToken = await createSession({ user, req, mfaPending: true });

      if (!user.totp_enrolled_at) {
        // Enrollment is mandatory, so hand out a seed now. It is not trusted
        // until a generated code proves the phone actually holds it.
        const secret = user.totp_secret || generateSecret();
        if (!user.totp_secret) {
          await supabase.from('admin_users').update({ totp_secret: secret }).eq('id', user.id);
        }
        await logAdminAction({ req, user, action: 'admin.login.password_ok.enrollment_required' });
        return res.json({
          mfaToken,
          enrollmentRequired: true,
          otpauthUrl: buildOtpauthUri(user.username, secret),
          secret,
        });
      }

      await logAdminAction({ req, user, action: 'admin.login.password_ok' });
      return res.json({ mfaToken, enrollmentRequired: false });
    } catch (error) {
      console.error('post /admin/auth/login error:', error);
      return res.status(500).json({ error: 'Sign-in failed', details: 'Please try again later' });
    }
  });

  /** POST /admin/auth/verify — second factor. Accepts a TOTP code or a recovery code. */
  app.post('/admin/auth/verify', verifyLimiter, async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Server not configured' });
      const mfaToken = String(req.body?.mfaToken || '');
      const code = String(req.body?.code || '').trim();
      const session = await loadSession(mfaToken);
      if (!session || !session.mfa_pending) {
        return res.status(401).json({ error: 'Session expired', details: 'Start again from the sign-in screen.' });
      }
      const user = session.user;
      if (isLocked(user)) {
        return res.status(423).json({ error: 'Account locked', details: 'Too many failed attempts. Try again shortly.' });
      }
      if (!user.totp_secret) {
        return res.status(409).json({ error: 'Not enrolled', details: 'Start again from the sign-in screen.' });
      }

      const enrolling = !user.totp_enrolled_at;
      let ok = await totpMatches(user.totp_secret, code);
      let usedRecovery = false;
      // A recovery code cannot stand in for the enrollment proof — during
      // enrollment none exist yet, and accepting one would let someone finish
      // setup without ever holding the authenticator.
      if (!ok && !enrolling) {
        ok = await consumeRecoveryCode(user.id, code);
        usedRecovery = ok;
      }

      if (!ok) {
        const nowLocked = await registerFailure(user);
        await logAdminAction({ req, user, action: 'admin.mfa.failed' });
        return res.status(nowLocked ? 423 : 401).json(nowLocked
          ? { error: 'Account locked', details: 'Too many failed attempts. Try again in 15 minutes.' }
          : { error: 'Invalid code', details: 'That code is not right. Check your authenticator and try again.' });
      }

      await clearFailures(user);
      await promoteSession(session.id);

      let recoveryCodes = null;
      const patch = { last_login_at: new Date().toISOString() };
      if (enrolling) {
        patch.totp_enrolled_at = new Date().toISOString();
        recoveryCodes = await issueRecoveryCodes(user.id);
      }
      await supabase.from('admin_users').update(patch).eq('id', user.id);

      await logAdminAction({
        req, user,
        action: enrolling ? 'admin.mfa.enrolled' : (usedRecovery ? 'admin.login.recovery_code' : 'admin.login.success'),
      });

      return res.json({
        token: mfaToken,
        admin: publicUser({ ...user, ...patch }),
        role: user.role,
        sections: DASHBOARD_SECTIONS[user.role] || [],
        // Shown once, at enrollment. Never retrievable again.
        recoveryCodes,
        recoveryCodeUsed: usedRecovery,
      });
    } catch (error) {
      console.error('post /admin/auth/verify error:', error);
      return res.status(500).json({ error: 'Verification failed', details: 'Please try again later' });
    }
  });

  /** POST /admin/auth/logout — revoke the current session. */
  app.post('/admin/auth/logout', async (req, res) => {
    try {
      await revokeSession(presentedCredential(req));
      return res.json({ ok: true });
    } catch (error) {
      console.error('post /admin/auth/logout error:', error);
      return res.json({ ok: true });
    }
  });
}

/** Routes that require an authenticated admin. `requireAdmin` is applied here. */
export function registerAdminAccountRoutes(app) {
  /** GET /admin/session — who am I, and what may I see. */
  app.get('/admin/session', requireAdmin, (req, res) => {
    const role = req.dashboardRole;
    return res.json({
      role,
      sections: DASHBOARD_SECTIONS[role] || [],
      admin: req.adminUser ? publicUser(req.adminUser) : null,
      // True while the pre-migration env keys are still in play, so the
      // dashboard can nag until real accounts exist.
      legacyKeyAuth: !!req.legacyKeyAuth,
    });
  });

  /** POST /admin/auth/change-password — own password. Re-checks the current one. */
  app.post('/admin/auth/change-password', requireAdmin, async (req, res) => {
    try {
      const user = req.adminUser;
      if (!user) return res.status(400).json({ error: 'Not available for key-based sessions' });
      const current = String(req.body?.currentPassword || '');
      const next = String(req.body?.newPassword || '');
      if (!verifyPassword(current, user.password_hash).valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      const strength = await assertStrongPassword(next);
      if (!strength.valid) return res.status(400).json({ error: strength.error });
      if (verifyPassword(next, user.password_hash).valid) {
        return res.status(400).json({ error: 'Choose a password you have not used here before' });
      }

      await supabase.from('admin_users')
        .update({ password_hash: hashPassword(next), must_change_password: false })
        .eq('id', user.id);
      // Every other session for this person dies, so a password change
      // actually evicts whoever prompted it.
      await revokeAllSessionsFor(user.id);
      await supabase.from('admin_sessions')
        .update({ revoked_at: null })
        .eq('id', req.adminSessionId);
      await logAdminAction({ req, user, action: 'admin.password.changed' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('post /admin/auth/change-password error:', error);
      return res.status(500).json({ error: 'Failed to change password', details: 'Please try again later' });
    }
  });

  /** GET /admin/admins — list accounts (admin only). Never returns secrets. */
  app.get('/admin/admins', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('admin_users')
        .select('id, username, full_name, role, is_active, totp_enrolled_at, must_change_password, last_login_at, created_at, locked_until')
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message || 'Failed to load admins');
      return res.json({
        admins: (data || []).map((u) => ({ ...publicUser(u), lockedUntil: u.locked_until })),
      });
    } catch (error) {
      console.error('get /admin/admins error:', error);
      return res.status(500).json({ error: 'Failed to load admins', details: 'Please try again later' });
    }
  });

  /** POST /admin/admins — create an account (admin only). */
  app.post('/admin/admins', requireAdmin, async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const role = String(req.body?.role || '');
      const password = String(req.body?.password || '');
      const fullName = String(req.body?.full_name || '').trim() || null;

      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return res.status(400).json({ error: 'Invalid username', details: '3-32 characters: letters, numbers, dot, dash or underscore' });
      }
      if (!DASHBOARD_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      const strength = await assertStrongPassword(password);
      if (!strength.valid) return res.status(400).json({ error: strength.error });

      const { data, error } = await supabase
        .from('admin_users')
        .insert({
          username,
          full_name: fullName,
          role,
          password_hash: hashPassword(password),
          // Whoever creates the account knows this password, so it is a
          // hand-over secret, not theirs.
          must_change_password: true,
          created_by: req.adminUser?.id || null,
        })
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That username is taken' });
        throw new Error(error.message || 'Failed to create admin');
      }
      await logAdminAction({ req, user: req.adminUser, action: 'admin.account.created', detail: { username, role } });
      return res.status(201).json({ admin: publicUser(data) });
    } catch (error) {
      console.error('post /admin/admins error:', error);
      return res.status(500).json({ error: 'Failed to create admin', details: error.message || 'Please try again later' });
    }
  });

  /** Refuses to strand the dashboard with no way back in. */
  async function wouldRemoveLastAdmin(targetId, { deactivating, changingRoleTo }) {
    const stillAdmin = !deactivating && (changingRoleTo === undefined || changingRoleTo === 'admin');
    if (stillAdmin) return false;
    const { count, error } = await supabase
      .from('admin_users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('is_active', true)
      .neq('id', targetId);
    if (error) throw new Error(error.message || 'Failed to count admins');
    return (count || 0) === 0;
  }

  /** PATCH /admin/admins/:id — deactivate, change role/name, reset password or 2FA. */
  app.patch('/admin/admins/:id', requireAdmin, async (req, res) => {
    try {
      const targetId = req.params.id;
      const { data: target, error: loadError } = await supabase
        .from('admin_users').select('*').eq('id', targetId).maybeSingle();
      if (loadError) throw new Error(loadError.message || 'Failed to load admin');
      if (!target) return res.status(404).json({ error: 'Admin not found' });

      const isSelf = req.adminUser?.id === targetId;
      const patch = {};
      const actions = [];

      if (req.body?.full_name !== undefined) patch.full_name = String(req.body.full_name).trim() || null;

      if (req.body?.role !== undefined) {
        if (!DASHBOARD_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
        // Demoting yourself is how an admin accidentally locks the whole team
        // out of account management.
        if (isSelf && req.body.role !== 'admin') {
          return res.status(400).json({ error: 'You cannot change your own role', details: 'Ask another admin to do it.' });
        }
        patch.role = req.body.role;
        actions.push('role');
      }

      if (req.body?.is_active !== undefined) {
        if (isSelf && req.body.is_active === false) {
          return res.status(400).json({ error: 'You cannot deactivate your own account' });
        }
        patch.is_active = !!req.body.is_active;
        actions.push(patch.is_active ? 'activate' : 'deactivate');
      }

      if (await wouldRemoveLastAdmin(targetId, {
        deactivating: patch.is_active === false,
        changingRoleTo: patch.role,
      })) {
        return res.status(400).json({ error: 'This is the last active admin', details: 'Promote someone else first.' });
      }

      if (req.body?.reset_password) {
        const strength = await assertStrongPassword(String(req.body.reset_password));
        if (!strength.valid) return res.status(400).json({ error: strength.error });
        patch.password_hash = hashPassword(String(req.body.reset_password));
        patch.must_change_password = true;
        actions.push('reset_password');
      }

      if (req.body?.reset_2fa) {
        // Clearing the seed forces a fresh enrollment on next sign-in. Old
        // recovery codes die with it, otherwise they would still open the
        // account the reset was meant to secure.
        patch.totp_secret = null;
        patch.totp_enrolled_at = null;
        await supabase.from('admin_recovery_codes').delete().eq('admin_user_id', targetId);
        actions.push('reset_2fa');
      }

      if (req.body?.unlock) {
        patch.locked_until = null;
        patch.failed_attempts = 0;
        actions.push('unlock');
      }

      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

      const { data, error } = await supabase
        .from('admin_users').update(patch).eq('id', targetId).select('*').single();
      if (error) throw new Error(error.message || 'Failed to update admin');

      // Anything that changes who they are or what they can reach must not
      // leave an already-issued session alive.
      if (patch.is_active === false || patch.role || patch.password_hash || patch.totp_secret === null) {
        await revokeAllSessionsFor(targetId);
      }
      await logAdminAction({
        req, user: req.adminUser, action: 'admin.account.updated',
        detail: { target: target.username, actions },
      });
      return res.json({ admin: publicUser(data) });
    } catch (error) {
      console.error('patch /admin/admins/:id error:', error);
      return res.status(500).json({ error: 'Failed to update admin', details: error.message || 'Please try again later' });
    }
  });

  /** DELETE /admin/admins/:id — remove an account outright. */
  app.delete('/admin/admins/:id', requireAdmin, async (req, res) => {
    try {
      const targetId = req.params.id;
      if (req.adminUser?.id === targetId) {
        return res.status(400).json({ error: 'You cannot delete your own account' });
      }
      const { data: target } = await supabase
        .from('admin_users').select('username').eq('id', targetId).maybeSingle();
      if (!target) return res.status(404).json({ error: 'Admin not found' });
      if (await wouldRemoveLastAdmin(targetId, { deactivating: true })) {
        return res.status(400).json({ error: 'This is the last active admin', details: 'Promote someone else first.' });
      }
      await revokeAllSessionsFor(targetId);
      const { error } = await supabase.from('admin_users').delete().eq('id', targetId);
      if (error) throw new Error(error.message || 'Failed to delete admin');
      await logAdminAction({ req, user: req.adminUser, action: 'admin.account.deleted', detail: { target: target.username } });
      return res.json({ ok: true });
    } catch (error) {
      console.error('delete /admin/admins/:id error:', error);
      return res.status(500).json({ error: 'Failed to delete admin', details: error.message || 'Please try again later' });
    }
  });

  /** GET /admin/audit-log — who did what (admin only). */
  app.get('/admin/audit-log', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      let query = supabase
        .from('admin_audit_log')
        .select('id, username, role, action, method, path, ip, detail, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (req.query.username) query = query.ilike('username', String(req.query.username));
      const { data, error } = await query;
      if (error) throw new Error(error.message || 'Failed to load audit log');
      return res.json({ entries: data || [] });
    } catch (error) {
      console.error('get /admin/audit-log error:', error);
      return res.status(500).json({ error: 'Failed to load audit log', details: 'Please try again later' });
    }
  });
}
