/**
 * The Delivery On Time code email. One layout for every code we send
 * (sign-up, password reset, PIN reset, new device, admin sign-in):
 *
 *   ┌───────────────────────────────────────────┐
 *   │ ┌───────────────────────────────────────┐ │
 *   │ │ D.O.T                    12 Nov 2026,  │ │  tinted panel
 *   │ │ DELIVERY ON TIME              2:14 PM  │ │
 *   │ │ Reset your PIN                         │ │
 *   │ │ We received a request…      [* * * *]  │ │
 *   │ │                               [lock]   │ │
 *   │ └───────────────────────────────────────┘ │
 *   │    Enter this code to choose your PIN.    │
 *   │  ┌─────────────────────────────────────┐  │
 *   │  │              4 8 2 9 1 7            │  │  the code, where a
 *   │  └─────────────────────────────────────┘  │  button would be
 *   │   If you didn't ask for this, ignore it.  │
 *   ├───────────────────────────────────────────┤
 *   │  © 2026 Delivery On Time · Support · Web  │  footer
 *   └───────────────────────────────────────────┘
 *
 * Email-safe: tables and inline styles only, no images or SVG (many mail
 * apps block them), so the padlock is drawn with styled blocks. A small
 * media query stacks the padlock under the text on phones.
 */

export const BRAND_GREEN = '#4F7942';
export const BRAND_GREEN_DARK = '#2F4A27';
export const BRAND_GOLD = '#F5A623';
export const BRAND_CREAM = '#F5F1E8';
export const SUPPORT_EMAIL = 'support@deliveryontime.co.zw';
const WEBSITE = 'https://deliveryontime.co.zw';
const INK = '#171B17';
const MUTED = '#6B7280';
const PANEL = '#EDF3E9';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** "12 November 2026," and "2:14 PM", in Zimbabwe time. */
function sentAt(now = new Date()) {
  try {
    const date = now.toLocaleDateString('en-GB', {
      timeZone: 'Africa/Harare', day: '2-digit', month: 'long', year: 'numeric',
    });
    const time = now.toLocaleTimeString('en-US', {
      timeZone: 'Africa/Harare', hour: 'numeric', minute: '2-digit',
    });
    return { date: `${date},`, time };
  } catch {
    return { date: '', time: '' };
  }
}

/** The padlock with its "* * * *" bubble, drawn without images. */
function padlock() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
  <tr><td align="center" style="padding-bottom:10px;">
    <span style="display:inline-block;background:#FFFFFF;border-radius:999px;padding:4px 14px;color:${BRAND_GOLD};font-size:22px;font-weight:800;letter-spacing:6px;line-height:26px;box-shadow:0 2px 6px rgba(47,74,39,0.12);">****</span>
  </td></tr>
  <tr><td align="center" style="line-height:0;font-size:0;">
    <div style="width:38px;height:30px;margin:0 auto;border:9px solid ${BRAND_GREEN};border-bottom:0;border-radius:30px 30px 0 0;"></div>
  </td></tr>
  <tr><td align="center" style="line-height:0;font-size:0;">
    <div style="width:84px;height:48px;padding-top:18px;margin:0 auto;background:${BRAND_GOLD};border-radius:12px;border-right:6px solid #D98B0B;border-bottom:6px solid #D98B0B;">
      <div style="width:14px;height:14px;margin:0 auto;background:${BRAND_GREEN_DARK};border-radius:50%;"></div>
      <div style="width:6px;height:14px;margin:-2px auto 0;background:${BRAND_GREEN_DARK};border-radius:0 0 3px 3px;"></div>
    </div>
  </td></tr>
</table>`;
}

/**
 * @param {object} o
 * @param {string} o.heading     Big title, e.g. "Reset your PIN"
 * @param {string} o.lead        One or two sentences under the title
 * @param {string} o.action      The line above the code, e.g. "Enter this code to…"
 * @param {string} o.code        The code itself
 * @param {string} [o.expiry]    e.g. "Expires in 10 minutes."
 * @param {string} [o.note]      The grey "if this wasn't you" line
 * @param {string} [o.name]      Greeting name
 * @param {string} [o.account]   Which account/store the code is for
 * @param {string} [o.tagline]   Under the D.O.T wordmark (default "DELIVERY ON TIME")
 */
export function codeEmailHtml({ heading, lead, action, code, expiry = '', note = '', name = '', account = '', tagline = 'DELIVERY ON TIME' }) {
  const { date, time } = sentAt();
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(heading)}</title>
<style>
  @media (max-width: 540px) {
    .dot-panel-text, .dot-panel-lock { display: block !important; width: 100% !important; }
    .dot-panel-lock { padding: 20px 0 0 !important; }
    .dot-heading { font-size: 28px !important; }
    .dot-pad { padding-left: 20px !important; padding-right: 20px !important; }
    .dot-code { font-size: 30px !important; letter-spacing: 7px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND_CREAM};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(action)} ${escapeHtml(String(code))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_CREAM};padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:22px;overflow:hidden;">

    <!-- Tinted panel: brand, date, title, padlock -->
    <tr><td style="padding:14px 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};border-radius:22px;">
        <tr><td class="dot-pad" style="padding:28px 32px 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="top">
                <div style="color:${BRAND_GREEN};font-size:26px;font-weight:800;letter-spacing:1px;line-height:1;">D.O.T</div>
                <div style="color:${BRAND_GOLD};font-size:10px;font-weight:800;letter-spacing:2.5px;margin-top:5px;">${escapeHtml(tagline)}</div>
              </td>
              <td valign="top" align="right" style="color:${INK};font-size:13px;line-height:1.6;white-space:nowrap;">
                ${escapeHtml(date)}<br>${escapeHtml(time)}
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
            <tr>
              <td class="dot-panel-text" valign="bottom" width="64%">
                <h1 class="dot-heading" style="margin:0 0 16px;color:${INK};font-size:34px;line-height:1.15;font-weight:800;">${escapeHtml(heading)}</h1>
                ${account ? `<div style="display:inline-block;margin:0 0 14px;padding:5px 12px;border-radius:999px;background:#FFFFFF;color:${BRAND_GREEN_DARK};font-size:13px;font-weight:700;">For: ${escapeHtml(account)}</div>` : ''}
                ${name ? `<p style="margin:0 0 4px;color:${INK};font-size:16px;line-height:1.5;font-weight:600;">Hi ${escapeHtml(name)},</p>` : ''}
                <p style="margin:0;color:${INK};font-size:16px;line-height:1.5;">${escapeHtml(lead)}</p>
              </td>
              <td class="dot-panel-lock" valign="bottom" width="36%" align="center" style="padding-left:12px;">
                ${padlock()}
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- The code, where a button would be -->
    <tr><td class="dot-pad" align="center" style="padding:36px 40px 8px;">
      <p style="margin:0 0 22px;color:${INK};font-size:22px;line-height:1.35;font-weight:500;">${escapeHtml(action)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td align="center" style="background:${BRAND_GREEN};border-radius:12px;padding:18px 12px;">
          <span class="dot-code" style="color:#FFFFFF;font-size:38px;font-weight:800;letter-spacing:12px;white-space:nowrap;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;">${escapeHtml(String(code))}</span>
        </td></tr>
      </table>
      ${expiry ? `<p style="margin:12px 0 0;color:${BRAND_GREEN_DARK};font-size:13px;font-weight:600;">${escapeHtml(expiry)}</p>` : ''}
      ${note ? `<p style="margin:24px 0 0;color:${MUTED};font-size:15px;line-height:1.6;">${escapeHtml(note)}</p>` : ''}
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:28px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F1EC;border-radius:0 0 22px 22px;">
        <tr><td align="center" style="padding:22px 24px;color:#9CA3AF;font-size:13px;line-height:1.8;">
          &copy; ${year} Delivery On Time. All rights reserved.<br>
          <a href="mailto:${SUPPORT_EMAIL}" style="color:#9CA3AF;text-decoration:underline;">Support</a>
          &nbsp;&bull;&nbsp;
          <a href="${WEBSITE}" style="color:#9CA3AF;text-decoration:underline;">deliveryontime.co.zw</a>
        </td></tr>
      </table>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}
