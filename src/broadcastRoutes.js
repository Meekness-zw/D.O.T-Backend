/**
 * Announcements from the admin dashboard (new deals, news, app updates).
 *
 * POST /admin/broadcast { title, message, audience? }
 *   audience: 'all' | 'customer' | 'merchant' | 'courier' (default 'all').
 *   Every matching account gets it in the app's notification list, and every
 *   phone with notifications on gets a push, so it shows in the phone's
 *   notification banner even when the app is closed.
 * GET /admin/broadcasts → { broadcasts: [...] }  the last 50 sent.
 *
 * Text is sent exactly as typed (not translated), like other typed content.
 */
import axios from 'axios';
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';
import { logAdminAction } from './adminAuth.js';

export const AUDIENCES = ['all', 'customer', 'merchant', 'courier'];
export const TITLE_MAX = 65;
export const MESSAGE_MAX = 240;
const PAGE = 1000; // Supabase returns at most 1000 rows per request
const EXPO_BATCH = 100; // Expo accepts up to 100 messages per request

const AUDIENCE_TABLE = { all: 'user_profiles', customer: 'customers', merchant: 'merchants', courier: 'couriers' };

/** Every id in a table, page by page (a plain select stops at 1000 rows). */
async function allIds(table) {
  const ids = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('id').order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message || `Failed to load ${table}`);
    ids.push(...(data || []).map((r) => r.id));
    if (!data || data.length < PAGE) return ids;
  }
}

/** Push tokens for these accounts, one per phone. */
async function pushTokens(ids, audience) {
  const tokens = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('push_token, push_role')
      .in('id', ids.slice(i, i + 200))
      .not('push_token', 'is', null);
    if (error) {
      console.error('[broadcast] push token lookup error:', error.message);
      continue;
    }
    (data || []).forEach((p) => {
      if (!String(p.push_token || '').startsWith('ExponentPushToken')) return;
      // A phone signed in as a courier must not get a customers-only deal.
      if (audience !== 'all' && p.push_role !== audience) return;
      tokens.add(p.push_token);
    });
  }
  return [...tokens];
}

export function validateBroadcast(body) {
  const title = String(body?.title || '').trim();
  const message = String(body?.message || '').trim();
  const audience = body?.audience || 'all';
  if (!title) return { error: 'Add a title' };
  if (!message) return { error: 'Add a message' };
  if (title.length > TITLE_MAX) return { error: `Keep the title to ${TITLE_MAX} characters so it fits on a phone` };
  if (message.length > MESSAGE_MAX) return { error: `Keep the message to ${MESSAGE_MAX} characters so it fits on a phone` };
  if (!AUDIENCES.includes(audience)) return { error: `audience must be one of: ${AUDIENCES.join(', ')}` };
  return { title, message, audience };
}

export function registerBroadcastRoutes(app, requireAdmin) {
  app.post('/admin/broadcast', requireAdmin, async (req, res) => {
    const input = validateBroadcast(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { title, message, audience } = input;
    try {
      const ids = await allIds(AUDIENCE_TABLE[audience]);
      if (!ids.length) return res.json({ sent: 0, pushed: 0, audience });

      // In-app notification list.
      const data = { audience };
      for (let i = 0; i < ids.length; i += 500) {
        const rows = ids.slice(i, i + 500).map((userId) => ({ user_id: userId, title, message, type: 'announcement', data }));
        const { error } = await supabase.from('notifications').insert(rows);
        if (error) console.error('[broadcast] notification insert error:', error.message);
      }

      // Phone banner.
      const tokens = await pushTokens(ids, audience);
      let pushed = 0;
      for (let i = 0; i < tokens.length; i += EXPO_BATCH) {
        const batch = tokens.slice(i, i + EXPO_BATCH).map((to) => ({
          to,
          title,
          body: message,
          sound: 'default',
          priority: 'high',
          channelId: 'default',
          data: { type: 'announcement', audience },
        }));
        try {
          const { data: result } = await axios.post('https://exp.host/--/api/v2/push/send', batch, {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            timeout: 15000,
          });
          const tickets = Array.isArray(result?.data) ? result.data : [];
          pushed += tickets.length ? tickets.filter((t) => t?.status === 'ok').length : batch.length;
        } catch (err) {
          console.warn('[broadcast] push batch failed:', err?.message);
        }
      }

      const summary = { sent: ids.length, pushed, phones: tokens.length, audience };
      await logAdminAction({
        req,
        user: req.adminUser || { role: req.dashboardRole },
        action: 'notification.broadcast',
        detail: { title, message, ...summary },
      });
      return res.json(summary);
    } catch (error) {
      console.error('post /admin/broadcast error:', error);
      return res.status(500).json({ error: 'Failed to send the notification', details: error.message || 'Please try again later' });
    }
  });

  app.get('/admin/broadcasts', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('admin_audit_log')
        .select('id, role, detail, created_at')
        .eq('action', 'notification.broadcast')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      const broadcasts = (data || []).map((row) => ({
        id: row.id,
        sent_at: row.created_at,
        by_role: row.role,
        ...(row.detail || {}),
      }));
      return res.json({ broadcasts });
    } catch (error) {
      console.error('get /admin/broadcasts error:', error);
      return res.status(500).json({ error: 'Could not load sent notifications', details: error.message });
    }
  });
}
