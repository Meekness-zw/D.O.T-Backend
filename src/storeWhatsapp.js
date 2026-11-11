/**
 * "Send to WhatsApp" for the DOT team on managed stores: the dashboard opens
 * WhatsApp with the order for the store, records that it was sent, and keeps
 * Accept locked until someone marks the store's confirmation.
 * Table: migrations/2026-11-12-order-store-whatsapp.sql.
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';

const ACTIONS = new Set(['sent', 'confirmed', 'reset']);

/** The order ids (of those given) that belong to this merchant's stores. */
async function ownedOrderIds(merchantId, orderIds) {
  const ids = [...new Set((orderIds || []).map(String).filter(Boolean))].slice(0, 200);
  if (!ids.length) return [];
  const { data: stores } = await supabase.from('stores').select('id').eq('merchant_id', merchantId);
  const storeIds = (stores || []).map((s) => s.id);
  if (!storeIds.length) return [];
  const { data: orders, error } = await supabase.from('orders').select('id').in('id', ids).in('store_id', storeIds);
  if (error) throw new Error(error.message);
  return (orders || []).map((o) => o.id);
}

function present(row) {
  return { sent_at: row.sent_at || null, confirmed_at: row.confirmed_at || null };
}

export function registerStoreWhatsappRoutes(app, requireAuth) {
  // GET /merchant/orders/whatsapp-status?ids=a,b → { statuses: { [orderId]: { sent_at, confirmed_at } } }
  app.get('/merchant/orders/whatsapp-status', requireAuth, async (req, res) => {
    try {
      const ids = await ownedOrderIds(req.userId, String(req.query.ids || '').split(','));
      if (!ids.length) return res.json({ statuses: {} });
      const { data, error } = await supabase
        .from('order_store_confirmations')
        .select('order_id, sent_at, confirmed_at')
        .in('order_id', ids);
      if (error) return res.status(503).json({ error: 'WhatsApp tracking is not set up yet', details: error.message });
      const statuses = {};
      (data || []).forEach((row) => {
        statuses[row.order_id] = present(row);
      });
      return res.json({ statuses });
    } catch (error) {
      console.error('get whatsapp-status error:', error);
      return res.status(500).json({ error: 'Could not load WhatsApp status' });
    }
  });

  // POST /merchant/orders/:id/whatsapp { action: 'sent' | 'confirmed' | 'reset' }
  app.post('/merchant/orders/:id/whatsapp', requireAuth, async (req, res) => {
    try {
      const action = String(req.body?.action || '');
      if (!ACTIONS.has(action)) return res.status(400).json({ error: 'action must be sent, confirmed or reset' });
      const [orderId] = await ownedOrderIds(req.userId, [req.params.id]);
      if (!orderId) return res.status(404).json({ error: 'Order not found' });

      const now = new Date().toISOString();
      const by = req.actingStaffId || req.userId;
      const { data: existing } = await supabase
        .from('order_store_confirmations')
        .select('order_id, sent_at, confirmed_at')
        .eq('order_id', orderId)
        .maybeSingle();
      const row = { order_id: orderId, updated_at: now };
      if (action === 'sent') {
        row.sent_at = existing?.sent_at || now;
        row.sent_by = by;
      } else if (action === 'confirmed') {
        row.sent_at = existing?.sent_at || now;
        row.confirmed_at = now;
        row.confirmed_by = by;
      } else {
        Object.assign(row, { sent_at: null, sent_by: null, confirmed_at: null, confirmed_by: null });
      }
      const { data, error } = await supabase
        .from('order_store_confirmations')
        .upsert(row, { onConflict: 'order_id' })
        .select('order_id, sent_at, confirmed_at')
        .single();
      if (error) return res.status(503).json({ error: 'WhatsApp tracking is not set up yet', details: error.message });
      return res.json({ status: present(data) });
    } catch (error) {
      console.error('post whatsapp error:', error);
      return res.status(500).json({ error: 'Could not save WhatsApp status' });
    }
  });
}
