import { Resend } from 'resend';

let cachedClient = null;
function getClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

const BRAND_GREEN = '#4F7942';
const BRAND_GOLD = '#F5A623';
const SUPPORT_EMAIL = 'support@deliveryontime.co.zw';

const EMAIL_COPY = {
  signup: {
    subject: 'Your Delivery On Time verification code',
    intro: 'Use this code to finish creating your Delivery On Time account. It expires in 10 minutes.',
    ignore: "If you didn't try to create an account, you can ignore this email.",
  },
  reset: {
    subject: 'Reset your Delivery On Time password',
    intro: 'Use this code to choose a new Delivery On Time password. It expires in 10 minutes.',
    ignore: "If you didn't ask to reset your password, you can ignore this email. Your password will stay the same.",
  },
};

function emailCopy(purpose) {
  return EMAIL_COPY[purpose] || EMAIL_COPY.signup;
}

/** Branded Delivery On Time message. Not a provider's default template. */
function otpEmailHtml({ code, name, purpose }) {
  const copy = emailCopy(purpose);
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#F5F1E8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:440px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background-color:${BRAND_GREEN};padding:28px 32px;text-align:center;">
                <span style="color:#F5F1E8;font-size:22px;font-weight:800;letter-spacing:1px;">D.O.T</span>
                <div style="color:${BRAND_GOLD};font-size:11px;font-weight:800;letter-spacing:2.5px;margin-top:4px;">DELIVERY ON TIME</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;color:#171B17;font-size:16px;">${greeting}</p>
                <p style="margin:0 0 24px;color:#4B5563;font-size:14px;line-height:1.5;">
                  ${copy.intro}
                </p>
                <div style="background-color:#F0FDF4;border:1px solid rgba(79,121,66,0.24);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
                  <div style="color:#6B7280;font-size:11px;font-weight:700;letter-spacing:1.5px;margin-bottom:8px;">YOUR CODE</div>
                  <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND_GREEN};">${escapeHtml(code)}</span>
                </div>
                <p style="margin:0;color:#6B7280;font-size:13px;line-height:1.5;">
                  ${copy.ignore}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #E8E4DA;text-align:center;">
                <p style="margin:0;color:#9CA3AF;font-size:12px;line-height:1.5;">
                  Delivery On Time<br>
                  Questions? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_GREEN};text-decoration:none;">${SUPPORT_EMAIL}</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function otpEmailText({ code, name, purpose }) {
  const copy = emailCopy(purpose);
  const greeting = name ? `Hi ${name},` : 'Hi,';
  return [
    greeting,
    '',
    copy.intro,
    '',
    `Your code: ${code}`,
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Sends a verification-code email via Resend using a custom branded
 * template. Throws on any failure — callers are expected to catch, since a
 * silently-swallowed failure would leave a user waiting on a code that never
 * arrives.
 */
export async function sendOtpEmail({ to, code, name, purpose = 'signup' }) {
  const client = getClient();
  const from = dotFromAddress(process.env.RESEND_FROM_EMAIL);
  if (!client || !from) {
    throw new Error('Email OTP service not configured');
  }
  const copy = emailCopy(purpose);
  const { error } = await client.emails.send({
    from,
    to,
    subject: copy.subject,
    html: otpEmailHtml({ code, name, purpose }),
    text: otpEmailText({ code, name, purpose }),
  });
  if (error) {
    throw new Error(error.message || 'Failed to send verification email');
  }
}
