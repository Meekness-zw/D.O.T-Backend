import { Resend } from 'resend';
import { codeEmailHtml, SUPPORT_EMAIL } from './emailTemplate.js';

let cachedClient = null;
function getClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

const EMAIL_COPY = {
  signup: {
    subject: 'Your Delivery On Time verification code',
    heading: 'Verify your account',
    lead: 'Welcome to Delivery On Time! Here is the code to finish creating your account.',
    action: 'Enter this code in the app to finish signing up.',
    ignore: "If you didn't try to create an account, you can ignore this email.",
  },
  reset: {
    subject: 'Reset your Delivery On Time password',
    heading: 'Reset your password',
    lead: 'We received a request to reset your password.',
    action: 'Enter this code to choose a new password.',
    ignore: "If you didn't ask to reset your password, no worries: ignore this email and your password stays the same.",
  },
  'new-device': {
    subject: 'Your Delivery On Time sign-in code',
    heading: 'Confirm it’s you',
    lead: 'Someone is signing in to your account on a new phone or browser.',
    action: 'Enter this code to finish signing in.',
    ignore: "If you didn't try to sign in, don't share this code with anyone. Your account stays safe without it.",
  },
  'pin-reset': {
    subject: 'Set your Delivery On Time PIN',
    heading: 'Reset your PIN',
    lead: 'We received a request to set a new 4-digit PIN for your account.',
    action: 'Enter this code to choose your new PIN.',
    ignore: "If you didn't ask for this, don't share this code with anyone. Your PIN stays the same.",
  },
};

const EXPIRY = 'Expires in 10 minutes.';

function emailCopy(purpose) {
  return EMAIL_COPY[purpose] || EMAIL_COPY.signup;
}

function otpEmailHtml({ code, name, purpose, account }) {
  const copy = emailCopy(purpose);
  return codeEmailHtml({
    heading: copy.heading,
    lead: copy.lead,
    action: copy.action,
    code,
    expiry: EXPIRY,
    note: copy.ignore,
    name,
    account,
  });
}

function otpEmailText({ code, name, purpose, account }) {
  const copy = emailCopy(purpose);
  return [
    name ? `Hi ${name},` : 'Hi,',
    ...(account ? ['', `For: ${account}`] : []),
    '',
    copy.lead,
    '',
    `${copy.action}`,
    `Your code: ${code}`,
    EXPIRY,
    '',
    copy.ignore,
    '',
    'Delivery On Time',
    SUPPORT_EMAIL,
  ].join('\n');
}

function dotFromAddress(from) {
  const raw = String(from || '').trim();
  if (!raw || raw.includes('<')) return raw;
  return `Delivery On Time <${raw}>`;
}


/**
 * Sends a verification-code email via Resend using a custom branded
 * template. `account` (optional) names the account the code is for, e.g.
 * "Yummy Sushi · +263771234567": many stores' codes go to the one DOT
 * inbox, and this says which store each one belongs to. Throws on any failure — callers are expected to catch, since a
 * silently-swallowed failure would leave a user waiting on a code that never
 * arrives.
 */
export async function sendOtpEmail({ to, code, name, purpose = 'signup', account = '' }) {
  const client = getClient();
  const from = dotFromAddress(process.env.RESEND_FROM_EMAIL);
  if (!client || !from) {
    throw new Error('Email OTP service not configured');
  }
  const copy = emailCopy(purpose);
  const { error } = await client.emails.send({
    from,
    to,
    subject: account ? `${copy.subject} (${account})` : copy.subject,
    html: otpEmailHtml({ code, name, purpose, account }),
    text: otpEmailText({ code, name, purpose, account }),
  });
  if (error) {
    throw new Error(error.message || 'Failed to send verification email');
  }
}
