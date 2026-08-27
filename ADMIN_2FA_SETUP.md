# Admin dashboard: per-admin accounts + two-factor

Replaces the three shared dashboard keys (`ADMIN_API_KEY`, `ACCOUNTANT_API_KEY`,
`SALES_MARKETING_API_KEY`) with named accounts, each with its own authenticator
and its own line in an audit log.

The rollout is **non-breaking**: until the first account exists, the old keys keep
working exactly as before. Nothing locks anyone out mid-deploy.

---

## Rollout, in order

### 1. Run the migration

Supabase → SQL Editor → New query → paste and run
[`supabase_migration_admin_2fa.sql`](./supabase_migration_admin_2fa.sql).

Creates `admin_users`, `admin_recovery_codes`, `admin_sessions`, `admin_audit_log`.
Safe to re-run.

### 2. Deploy the backend

At this point nothing has changed for anyone. `admin_users` is empty, so the env
keys still authenticate and the dashboard behaves as it always has.

### 3. Create the first account

One call, authenticated with the existing `ADMIN_API_KEY`:

```bash
curl -X POST https://d-o-t-backend.onrender.com/admin/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"username":"tafara","password":"a-long-passphrase-you-choose","full_name":"Tafara M"}'
```

**The moment this succeeds, the env keys stop granting dashboard access.** They are
no longer a way past the second factor — which is the entire point. Everyone signs
in with a username, a password and a 6-digit code from here on.

### 4. Deploy the dashboard

Then sign in as the account from step 3. You will be walked through scanning a QR
code and shown ten recovery codes. **Save those** — they are shown once.

### 5. Add everyone else

Admin Accounts → **+ New admin account**. Set a temporary password and hand it over
directly. They will be forced to choose their own password and enroll their own
authenticator before the dashboard opens for them.

### 6. Clean up

Once everyone has an account, delete `ACCOUNTANT_API_KEY` and
`SALES_MARKETING_API_KEY` from Render. Keep `ADMIN_API_KEY` only for the
break-glass path below.

---

## If someone loses their phone

- **They have recovery codes** — enter one instead of the 6-digit code at sign-in.
  Each works once.
- **They don't** — any admin can hit **Reset 2FA** on their row. Their old
  authenticator and recovery codes stop working and they enroll again next sign-in.

## If *everyone* is locked out

Set `ADMIN_BOOTSTRAP_ENABLED=true` in Render, then re-run the step-3 curl to mint a
recovery admin. **Unset it again afterwards** — while it is set, `ADMIN_API_KEY`
alone can create an admin account, which is a way around 2FA.

The last resort is Supabase SQL:

```sql
-- Force a fresh enrollment for one person (they keep their password).
UPDATE admin_users SET totp_secret = NULL, totp_enrolled_at = NULL,
       locked_until = NULL, failed_attempts = 0
 WHERE username = 'tafara';
DELETE FROM admin_recovery_codes
 WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'tafara');
```

---

## How it works

| | |
|---|---|
| Factor | TOTP, RFC 6238 — SHA-1, 6 digits, 30s, ±30s drift |
| Password storage | bcrypt (shared with the customer path) |
| Session | 12 hours, random 32 bytes, only its SHA-256 is stored |
| Between factors | 5-minute token that no dashboard endpoint accepts |
| Lockout | 5 failed attempts → 15 minutes, covering password *and* code |
| Recovery codes | 10 per person, single-use, SHA-256 |
| Audit | Every non-GET request, plus sign-in successes and failures |

Sessions are revoked immediately when an account is disabled, deleted, has its role
changed, or has its password or 2FA reset — a live browser tab does not outlive the
change.

`ADMIN_BOOTSTRAP_ENABLED` is the only new environment variable, and it should
normally be unset.
