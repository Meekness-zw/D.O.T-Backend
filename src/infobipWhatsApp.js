import axios from 'axios';
import crypto from 'crypto';

/**
 * Sends a verification code on WhatsApp using an Infobip template.
 * The API key and base URL stay in the server environment:
 *   INFOBIP_API_KEY
 *   INFOBIP_BASE_URL          e.g. https://3dqd41.api.infobip.com
 *   INFOBIP_WHATSAPP_FROM     sender number, default 447860088970
 *   INFOBIP_WHATSAPP_TEMPLATE template name, default test_whatsapp_template_en
 *   INFOBIP_WHATSAPP_LANGUAGE default en
 * The code is the template's first body placeholder.
 */
export function infobipWhatsAppConfigured() {
  return Boolean(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);
}

export async function sendWhatsAppTemplate({ to, placeholder }) {
  const apiKey = process.env.INFOBIP_API_KEY;
  const baseUrl = String(process.env.INFOBIP_BASE_URL || '').replace(/\/$/, '');
  if (!apiKey || !baseUrl) {
    const error = new Error('WhatsApp OTP is not configured');
    error.code = 'not_configured';
    throw error;
  }

  const destination = String(to || '').replace(/^\+/, '');
  const response = await axios.post(
    `${baseUrl}/whatsapp/1/message/template`,
    {
      messages: [
        {
          from: process.env.INFOBIP_WHATSAPP_FROM || '447860088970',
          to: destination,
          messageId: crypto.randomUUID(),
          content: {
            templateName: process.env.INFOBIP_WHATSAPP_TEMPLATE || 'test_whatsapp_template_en',
            templateData: {
              body: {
                placeholders: [String(placeholder)],
              },
            },
            language: process.env.INFOBIP_WHATSAPP_LANGUAGE || 'en',
          },
        },
      ],
    },
    {
      headers: {
        Authorization: `App ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    },
  );

  const status = response.data?.messages?.[0]?.status;
  const group = String(status?.groupName || '').toUpperCase();
  if (group && !['PENDING', 'ACCEPTED', 'DELIVERED'].includes(group)) {
    const error = new Error(status?.description || status?.name || 'WhatsApp message was rejected');
    error.response = { status: 400, data: response.data };
    throw error;
  }

  return response.data;
}
