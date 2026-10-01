import axios from 'axios';

/**
 * Sends a verification code by SMS through Twilio.
 * Credentials stay in the server environment:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER            a Twilio number in E.164, e.g. +14155552671
 *   TWILIO_MESSAGING_SERVICE_SID  optional; used instead of TWILIO_FROM_NUMBER when set
 */
export function twilioSmsConfigured() {
  const hasSender = Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER);
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && hasSender);
}

export async function sendTwilioSms({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || (!messagingServiceSid && !from)) {
    const error = new Error('SMS OTP is not configured');
    error.code = 'not_configured';
    throw error;
  }

  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);
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

  const status = String(response.data?.status || '').toLowerCase();
  if (status && !['queued', 'accepted', 'sending', 'sent', 'delivered'].includes(status)) {
    const error = new Error(response.data?.error_message || 'SMS was not accepted');
    error.response = { status: 400, data: response.data };
    throw error;
  }

  return response.data;
}
