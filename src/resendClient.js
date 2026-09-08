import { Resend } from 'resend';

let cachedClient = null;
function getClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

const BRAND_GREEN = '#4F7942';

/** Custom-branded OTP email — deliberately not Resend's default example template. */
function otpEmailHtml({ code, name }) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#F5F1E8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:420px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background-color:${BRAND_GREEN};padding:28px 32px;text-align:center;">
                <span style="color:#F5F1E8;font-size:20px;font-weight:800;letter-spacing:1px;">D.O.T</span>
                <div style="color:#F5A623;font-size:10px;font-weight:800;letter-spacing:2.5px;margin-top:2px;">DELIVERY ON TIME</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;color:#171B17;font-size:16px;">${greeting}</p>
                <p style="margin:0 0 24px;color:#4B5563;font-size:14px;line-height:1.5;">
                  Here is your verification code. It expires in 10 minutes.
                </p>
                <div style="background-color:#F0FDF4;border:1px solid rgba(79,121,66,0.24);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
                  <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND_GREEN};">${escapeHtml(code)}</span>
                </div>
                <p style="margin:0;color:#9CA3AF;font-size:12px;line-height:1.5;">
                  If you didn't request this code, you can safely ignore this email.
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
export async function sendOtpEmail({ to, code, name }) {
  const client = getClient();
  const from = process.env.RESEND_FROM_EMAIL;
  if (!client || !from) {
    throw new Error('Email OTP service not configured');
  }
  const { error } = await client.emails.send({
    from,
    to,
    subject: `Your D.O.T verification code: ${code}`,
    html: otpEmailHtml({ code, name }),
  });
  if (error) {
    throw new Error(error.message || 'Failed to send verification email');
  }
}
