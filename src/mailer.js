/**
 * Transactional email for admin sign-in codes.
 *
 * Talks to Resend (or SendGrid) over plain HTTPS with axios, which the backend
 * already depends on — a whole SDK for one POST would be weight for nothing.
 *
 * Configure in Render:
 *   EMAIL_PROVIDER   'resend' (default) or 'sendgrid'
 *   EMAIL_API_KEY    the provider's API key
 *   EMAIL_FROM       e.g. "Delivery On Time <no-reply@deliveryontime.co.zw>"
 *
 * Until the sending domain is verified, Resend only delivers to the address
 * that owns the account, so test with that one first.
 */
import axios from 'axios';

const PROVIDERS = {
  resend: {
    url: 'https://api.resend.com/emails',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ to, from, subject, html, text }) => ({ from, to: [to], subject, html, text }),
  },
  sendgrid: {
    url: 'https://api.sendgrid.com/v3/mail/send',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ to, from, subject, html, text }) => ({
      personalizations: [{ to: [{ email: to }] }],
      from: parseFrom(from),
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
    }),
  },
};

/** "Name <a@b.c>" → { email, name }, which is the shape SendGrid wants. */
function parseFrom(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return match ? { email: match[2], name: match[1] || undefined } : { email: from };
}

export function emailConfigured() {
  return !!(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) {
    throw new Error('Email is not configured: set EMAIL_API_KEY and EMAIL_FROM');
  }
  const name = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown EMAIL_PROVIDER "${name}"`);

  const from = process.env.EMAIL_FROM;
  try {
    await axios.post(
      provider.url,
      provider.body({ to, from, subject, html, text }),
      { headers: provider.headers(process.env.EMAIL_API_KEY), timeout: 12000 },
    );
  } catch (err) {
    // Log the provider's own reason — "email failed" alone is useless when the
    // real cause is an unverified domain or a bad key.
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[mailer] ${name} send failed (${err.response?.status || 'no status'}): ${detail}`);
    throw new Error('Failed to send email');
  }
}

/**
 * The sign-in code email.
 *
 * Deliberately plain: no tracking pixels, no link to click. A code the person
 * types back into a page they already have open cannot be turned into a
 * phishing click, and mail that looks like marketing gets filtered.
 */
export function signInCodeEmail({ code, username, minutes }) {
  const subject = `${code} is your Delivery On Time admin code`;
  const text = [
    `Your admin sign-in code is ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    '',
    `If you did not try to sign in as "${username}", someone has your password.`,
    'Change it as soon as you can and tell the other admins.',
  ].join('\n');

  const html = `
<div style="font-family:'Outfit',system-ui,-apple-system,'Segoe UI',sans-serif;background:#0D0D0D;padding:32px 16px;">
  <div style="max-width:440px;margin:0 auto;background:#14181F;border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:32px;">
    <div style="font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#38B676;margin-bottom:22px;">
      Delivery On Time — Admin
    </div>
    <div style="font-size:15px;color:rgba(233,238,246,0.66);margin-bottom:20px;">
      Signing in as <strong style="color:#E9EEF6;">${escapeHtml(username)}</strong>. Enter this code to finish:
    </div>
    <div style="font-size:38px;font-weight:800;letter-spacing:9px;color:#F5A623;text-align:center;
                background:rgba(245,166,35,0.09);border:1px dashed rgba(245,166,35,0.42);
                border-radius:12px;padding:18px 10px;margin-bottom:20px;">
      ${escapeHtml(code)}
    </div>
    <div style="font-size:13px;color:rgba(233,238,246,0.45);line-height:1.7;">
      Expires in ${minutes} minutes, and works once.<br />
      If this wasn't you, someone knows that account's password — change it now
      and tell the other admins.
    </div>
  </div>
</div>`.trim();

  return { subject, text, html };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
