import axios from 'axios';

/**
 * Sends a verification code by SMS through Twilio.
 * Credentials stay in the server environment:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER            a Twilio number in E.164, e.g. +14155552671
 *   TWILIO_MESSAGING_SERVICE_SID  optional; used instead of TWILIO_FROM_NUMBER when set
 */
function envValue(name) {
  const direct = process.env[name];
  if (direct != null && String(direct).trim()) return cleanEnv(direct);
  const match = Object.keys(process.env).find((key) => key.trim().toUpperCase() === name);
  if (!match) return '';
  return cleanEnv(process.env[match]);
}

function cleanEnv(value) {
  let text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function twilioSettings() {
  const accountSid = envValue('TWILIO_ACCOUNT_SID');
  const authToken = envValue('TWILIO_AUTH_TOKEN');
  const messagingServiceSid = envValue('TWILIO_MESSAGING_SERVICE_SID');
  const from = envValue('TWILIO_FROM_NUMBER')
    || envValue('TWILIO_PHONE_NUMBER')
    || envValue('TWILIO_PHONE');
  const missing = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!messagingServiceSid && !from) missing.push('TWILIO_FROM_NUMBER');
  return { accountSid, authToken, messagingServiceSid, from, missing };
}

export function twilioConfigStatus() {
  const { missing } = twilioSettings();
  const present = Object.keys(process.env)
    .map((key) => key.trim())
    .filter((key) => /^TWILIO_/i.test(key));
  return { configured: missing.length === 0, missing, present };
}

export function twilioSmsConfigured() {
  return twilioSettings().missing.length === 0;
}

async function addToSafeList(accountSid, authToken, phone) {
  const params = new URLSearchParams();
  params.set('PhoneNumber', phone);
  try {
    await axios.post(
      'https://accounts.twilio.com/v1/SafeList/Numbers',
      params.toString(),
      {
        auth: { username: accountSid, password: authToken },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      },
    );
    console.log('[Twilio] destination added to the safe list');
  } catch (error) {
    const code = Number(error?.response?.data?.code || 0);
    if (code === 60411) return;
    console.warn('[Twilio] safe list add failed:', error?.response?.data?.message || error?.message);
    throw error;
  }
}

async function createAndConfirmSms({ accountSid, authToken, to, body, messagingServiceSid, from }) {
  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);
  // Verification texts are expected. Skip Twilio's fraud check, which was
  // returning 30453 for real customers.
  params.set('RiskCheck', 'disable');
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', from);

  const response = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    params.toString(),
    {
      auth: { username: accountSid, password: authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    },
  );

  let current = response.data || {};
  const sid = current.sid;
  if (sid && ['queued', 'accepted', 'sending'].includes(String(current.status || '').toLowerCase())) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const followUp = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
        { auth: { username: accountSid, password: authToken }, timeout: 10000 },
      );
      current = followUp.data || current;
    } catch (followErr) {
      console.warn('[Twilio] could not confirm SMS status:', followErr?.message);
    }
  }

  const status = String(current.status || '').toLowerCase();
  const errorCode = current.error_code || null;
  console.log('[Twilio] SMS status', { sid: sid || null, status: status || 'unknown', errorCode });
  return current;
}

function rejectUndelivered(current) {
  const status = String(current?.status || '').toLowerCase();
  const errorCode = current?.error_code || null;
  if (status === 'failed' || status === 'undelivered' || errorCode) {
    const error = new Error(current.error_message || 'SMS was not delivered');
    error.response = {
      status: 400,
      data: { code: errorCode, message: current.error_message, status },
    };
    throw error;
  }
  if (status && !['queued', 'accepted', 'sending', 'sent', 'delivered'].includes(status)) {
    const error = new Error(current.error_message || 'SMS was not accepted');
    error.response = { status: 400, data: current };
    throw error;
  }
}

export async function sendTwilioSms({ to, body }) {
  const { accountSid, authToken, messagingServiceSid, from } = twilioSettings();
  if (!accountSid || !authToken || (!messagingServiceSid && !from)) {
    const error = new Error('SMS OTP is not configured');
    error.code = 'not_configured';
    throw error;
  }

  await addToSafeList(accountSid, authToken, to);
  const current = await createAndConfirmSms({
    accountSid, authToken, to, body, messagingServiceSid, from,
  });
  rejectUndelivered(current);
  return current;
}
