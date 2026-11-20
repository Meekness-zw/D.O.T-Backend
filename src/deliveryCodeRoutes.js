/**
 * Customer delivery codes for the admin dashboard (security checks and
 * settling disputes). Admin role only, and every look is written to
 * admin_audit_log, so there is a record of who saw which code and when.
 *
 * GET /admin/orders/:id/delivery-code  → { order_number, delivery_code }
 * GET /admin/delivery-codes/open       → { orders: [...] } every open order with its code
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';
import { logAdminAction } from './adminAuth.js';

/** Finished orders: their code no longer unlocks anything. */
export const CLOSED_STATUSES = ['delivered', 'completed', 'cancelled', 'refunded'];

const adminOnly = (req, res) => {
  if (req.dashboardRole === 'admin') return true;
  res.status(403).json({ error: 'Only admins can see delivery codes' });
  return false;
};

const actor = (req) => req.adminUser || { role: req.dashboardRole };

const pickOne = (v) => (Array.isArray(v) ? v[0] : v) || null;

export function registerDeliveryCodeRoutes(app, requireAdmin) {
  app.get('/admin/orders/:id/delivery-code', requireAdmin, async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_number, status, delivery_code')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Order not found' });
      await logAdminAction({
        req,
        user: actor(req),
        action: 'order.delivery_code.view',
        detail: { order_id: data.id, order_number: data.order_number, status: data.status },
      });
      return res.json({ order_number: data.order_number, status: data.status, delivery_code: data.delivery_code || null });
    } catch (error) {
      console.error('get /admin/orders/:id/delivery-code error:', error);
      return res.status(500).json({ error: 'Could not load the delivery code', details: error.message });
    }
  });

  app.get('/admin/delivery-codes/open', requireAdmin, async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
      const { data, error } = await supabase
        .from('orders')
        .select(`id, order_number, status, payment_status, created_at, delivery_code, delivery_address,
                 customer_id, courier_id, stores ( store_name )`)
        .not('status', 'in', `(${CLOSED_STATUSES.join(',')})`)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      const rows = data || [];

      const people = [...new Set(rows.flatMap((o) => [o.customer_id, o.courier_id]).filter(Boolean))];
      const names = new Map();
      if (people.length) {
        const { data: profiles } = await supabase.from('user_profiles').select('id, full_name, phone').in('id', people);
        (profiles || []).forEach((p) => names.set(p.id, p));
      }

      const orders = rows.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        status: o.status,
        payment_status: o.payment_status,
        created_at: o.created_at,
        delivery_code: o.delivery_code || null,
        store_name: pickOne(o.stores)?.store_name || null,
        customer: names.get(o.customer_id) || null,
        courier: names.get(o.courier_id) || null,
      }));
      await logAdminAction({
        req,
        user: actor(req),
        action: 'order.delivery_code.list',
        detail: { count: orders.length, order_numbers: orders.map((o) => o.order_number).slice(0, 200) },
      });
      return res.json({ orders });
    } catch (error) {
      console.error('get /admin/delivery-codes/open error:', error);
      return res.status(500).json({ error: 'Could not load delivery codes', details: error.message });
    }
  });
}
