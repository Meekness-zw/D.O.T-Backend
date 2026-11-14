/**
 * Admin dashboard: permanently delete an account (customer, courier,
 * merchant) or a store, with everything linked to it — orders included.
 *
 * The work is done by the database function public.dot_admin_delete
 * (migrations/2026-11-13-admin-delete.sql), in one transaction: either all of
 * it goes, or none of it does. Its dry run is the preview the dashboard shows
 * before the admin confirms.
 *
 * Only the full "admin" role reaches these routes (dashboardRoleCanAccess
 * refuses DELETE and this preview to accountant and marketing logins), and
 * each delete is written to the admin audit log with what it removed.
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';
import { logAdminAction } from './adminAuth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Table name → how the dashboard names it in "this will delete …". */
const LABELS = {
  'auth.users': ['login', 'logins'],
  user_profiles: ['account profile', 'account profiles'],
  customers: ['customer profile', 'customer profiles'],
  couriers: ['courier profile', 'courier profiles'],
  merchants: ['merchant profile', 'merchant profiles'],
  stores: ['store', 'stores'],
  products: ['product', 'products'],
  orders: ['order', 'orders'],
  order_items: ['order item', 'order items'],
  payments: ['payment', 'payments'],
  wallet_transactions: ['wallet entry', 'wallet entries'],
  reviews: ['review', 'reviews'],
  promotions: ['promotion', 'promotions'],
  settlements: ['settlement', 'settlements'],
};

function describe(counts = {}) {
  // Most important first, then everything else by size.
  const order = ['orders', 'stores', 'products', 'payments', 'wallet_transactions', 'reviews', 'user_profiles', 'auth.users'];
  return Object.entries(counts)
    .map(([table, n]) => {
      const key = String(table).replace(/^public\./, '');
      const [one, many] = LABELS[key] || [key.replace(/_/g, ' '), key.replace(/_/g, ' ')];
      return { table: key, count: Number(n) || 0, label: `${n} ${Number(n) === 1 ? one : many}` };
    })
    .sort((a, b) => {
      const ia = order.indexOf(a.table);
      const ib = order.indexOf(b.table);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return b.count - a.count;
    });
}

async function runDelete(kind, id, dryRun) {
  const { data, error } = await supabase.rpc('dot_admin_delete', { p_kind: kind, p_id: id, p_dry_run: dryRun });
  if (error) throw error;
  return data || { deleted: {} };
}

/** A database error → the status and message the dashboard shows. */
function failure(res, error, what) {
  const msg = error?.message || '';
  if (/dot_not_found/.test(msg)) {
    return res.status(404).json({ error: `${what} not found`, details: 'It may already have been deleted.' });
  }
  if (error?.code === 'PGRST202' || /Could not find the function/i.test(msg)) {
    return res.status(503).json({
      error: 'Delete is not set up yet',
      details: 'Run backend/migrations/2026-11-13-admin-delete.sql in Supabase → SQL Editor, then try again.',
    });
  }
  if (error?.code === '23503') {
    // Something outside the app's tables still points at it; nothing was deleted.
    return res.status(409).json({
      error: `This ${what.toLowerCase()} can't be deleted yet`,
      details: `Something still links to it, so nothing was deleted. (${msg})`,
    });
  }
  console.error(`admin delete ${what} error:`, error);
  return res.status(500).json({ error: `Failed to delete ${what.toLowerCase()}`, details: msg || 'Try again later' });
}

export function registerAdminDeleteRoutes(app, requireAdmin) {
  // GET /admin/delete-preview?kind=account|store&id=… — what a delete would remove. Changes nothing.
  app.get('/admin/delete-preview', requireAdmin, async (req, res) => {
    const kind = req.query.kind === 'store' ? 'store' : req.query.kind === 'account' ? 'account' : null;
    const id = String(req.query.id || '');
    if (!kind || !UUID_RE.test(id)) return res.status(400).json({ error: 'kind (account or store) and a valid id are required' });
    try {
      const result = await runDelete(kind, id, true);
      return res.json({ kind, id, items: describe(result.deleted) });
    } catch (error) {
      return failure(res, error, kind === 'store' ? 'Store' : 'Account');
    }
  });

  // DELETE /admin/stores/:id — the store, its products and its orders.
  app.delete('/admin/stores/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'A valid store id is required' });
    try {
      const { data: store } = await supabase.from('stores').select('store_name').eq('id', id).maybeSingle();
      const result = await runDelete('store', id, false);
      const items = describe(result.deleted);
      await logAdminAction({
        req, user: req.adminUser, action: 'store.delete',
        detail: { store_id: id, store_name: store?.store_name || null, deleted: result.deleted },
      });
      return res.json({ success: true, message: 'Store deleted', items });
    } catch (error) {
      return failure(res, error, 'Store');
    }
  });

  // DELETE /admin/users/:id — the whole account (any role), its stores and orders.
  app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'A valid user id is required' });
    try {
      const { data: profile } = await supabase
        .from('user_profiles').select('full_name, phone').eq('id', id).maybeSingle();
      const result = await runDelete('account', id, false);
      const items = describe(result.deleted);
      await logAdminAction({
        req, user: req.adminUser, action: 'account.delete',
        detail: { user_id: id, name: profile?.full_name || null, phone: profile?.phone || null, deleted: result.deleted },
      });
      return res.json({ success: true, message: 'Account deleted', items });
    } catch (error) {
      return failure(res, error, 'Account');
    }
  });
}
