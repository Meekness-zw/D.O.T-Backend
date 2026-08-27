# Admin dashboard: per-admin accounts + emailed sign-in codes

Replaces the three shared dashboard keys (`ADMIN_API_KEY`, `ACCOUNTANT_API_KEY`,
`SALES_MARKETING_API_KEY`) with named accounts. Each person signs in with their
own username and password, then a 6-digit code emailed to their own address,
and each has their own line in an audit log.

Codes go to the individual, not to a shared mailbox: a single shared inbox
would make every audit entry read the same and turn inbox access into admin
access.

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
  -d '{"username":"tafara","email":"tafara@deliveryontime.co.zw","password":"a-long-passphrase-you-choose","full_name":"Tafara M"}'
```

**The moment this succeeds, the env keys stop granting dashboard access.** They are
no longer a way past the second factor — which is the entire point. Everyone signs
in with a username, a password and a 6-digit code from here on.

### 4. Deploy the dashboard

Then sign in as the account from step 3. A 6-digit code is emailed to you, and after
signing in you are shown ten recovery codes. **Save those** — they are shown once.

### 5. Add everyone else

Admin Accounts → **+ New admin account**. Set a temporary password and hand it over
directly, along with the email address you set for them. They must choose their own
password before the dashboard opens, and every sign-in emails them a code.

### 6. Clean up

Once everyone has an account, delete `ACCOUNTANT_API_KEY` and
`SALES_MARKETING_API_KEY` from Render. Keep `ADMIN_API_KEY` only for the
break-glass path below.

---

## If someone cannot reach their email

- **They have recovery codes** — enter one instead of the 6-digit code at sign-in.
  Each works once.
- **They don't** — any admin can change their email address on the Admin Accounts
  page, or hit **Reset sign-in** to invalidate any outstanding code.

## If *everyone* is locked out

Set `ADMIN_BOOTSTRAP_ENABLED=true` in Render, then re-run the step-3 curl to mint a
recovery admin. **Unset it again afterwards** — while it is set, `ADMIN_API_KEY`
alone can create an admin account, which is a way around 2FA.

The last resort is Supabase SQL:

```sql
-- Point one account at a mailbox you can actually open, and clear any lockout.
UPDATE admin_users
   SET email = 'you@somewhere-you-can-read.com',
       locked_until = NULL, failed_attempts = 0
 WHERE username = 'tafara';

-- Kill anything still redeemable for that account.
UPDATE admin_login_codes SET consumed_at = NOW()
 WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'tafara')
   AND consumed_at IS NULL;
```

---

## How it works

| | |
|---|---|
| Factor | 6-digit code emailed to the admin, valid 10 minutes, single use |
| Email | Resend or SendGrid — `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` |
| Code abuse | 5 wrong guesses burns the code; 5 code requests per account per hour |
| Password storage | bcrypt (shared with the customer path) |
| Session | 12 hours, random 32 bytes, only its SHA-256 is stored |
| Between factors | 10-minute token that no dashboard endpoint accepts |
| Lockout | 5 failed attempts → 15 minutes, covering password *and* code |
| Recovery codes | 10 per person, single-use, SHA-256 — for when email is unreachable |
| Audit | Every non-GET request, plus sign-in successes and failures |

Sessions are revoked immediately when an account is disabled, deleted, has its role
changed, or has its password or 2FA reset — a live browser tab does not outlive the
change.

New environment variables: `EMAIL_PROVIDER`, `EMAIL_API_KEY` and `EMAIL_FROM` for
sending, plus `ADMIN_BOOTSTRAP_ENABLED`, which should normally be unset.

Until the sending domain is verified with Resend, it will only deliver to the
address that owns the Resend account — test with that one first.
