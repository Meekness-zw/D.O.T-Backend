/**
 * Saved variants per store (migrations/2026-11-19-store-variant-groups.sql).
 *
 * A store keeps a list of variant groups (Size, Flavour, Extras…) typed once.
 * A product ticks the ones it uses: the product still gets its own rows in
 * product_option_groups / product_options (what the app, cart and orders
 * read), marked with variant_group_id. Editing a saved group rewrites every
 * linked product's copy, so a price change is made in one place.
 *
 * Routes (same shape for the admin dashboard and the merchant dashboard):
 *   GET    /admin/stores/:storeId/variant-groups          /merchant/stores/:storeId/variant-groups
 *   POST   …/variant-groups                 { name, is_required, max_select, options }
 *   PATCH  …/variant-groups/:groupId        same fields; updates linked products
 *   DELETE …/variant-groups/:groupId        removes it from linked products too
 */
import { supabaseAdmin as supabase } from './supabaseAdminClient.js';

const TABLE = 'store_variant_groups';
const SELECT = 'id, store_id, name, is_required, max_select, options, display_order';

const isMissingTable = (error) =>
  /store_variant_groups|variant_group_id/.test(String(error?.message || '')) &&
  /does not exist|schema cache|Could not find/i.test(String(error?.message || ''));

const notSetUp = (res) =>
  res.status(503).json({
    error: 'Saved variants are not set up yet',
    details: 'Run migrations/2026-11-19-store-variant-groups.sql in Supabase.',
  });

/** Cleans a variant group from a request; returns { error } when unusable. */
export function normalizeVariantGroup(body) {
  const name = String(body?.name || '').trim().slice(0, 80);
  if (!name) return { error: 'Give the variant group a name (e.g. Size)' };
  const options = (Array.isArray(body?.options) ? body.options : [])
    .filter((o) => o && String(o.name || '').trim())
    .slice(0, 50)
    .map((o) => ({
      name: String(o.name).trim().slice(0, 80),
      price_adjustment: Math.round((Number(o.price_adjustment) || 0) * 100) / 100,
      is_available: o.is_available !== false,
    }));
  if (!options.length) return { error: 'Add at least one option (e.g. Small)' };
  const maxSelect = Math.max(1, parseInt(body?.max_select, 10) || 1);
  return {
    name,
    is_required: !!body?.is_required,
    max_select: Math.min(maxSelect, options.length),
    options,
  };
}

function present(row, usage) {
  return {
    id: row.id,
    name: row.name,
    is_required: !!row.is_required,
    max_select: row.max_select || 1,
    options: Array.isArray(row.options) ? row.options : [],
    product_count: usage.get(row.id) || 0,
  };
}

async function usageCounts(groupIds) {
  const usage = new Map();
  if (!groupIds.length) return usage;
  const { data } = await supabase.from('product_option_groups').select('variant_group_id').in('variant_group_id', groupIds);
  (data || []).forEach((r) => usage.set(r.variant_group_id, (usage.get(r.variant_group_id) || 0) + 1));
  return usage;
}

/** Rewrites every product's copy of a saved group to match it. */
async function syncLinkedProducts(group) {
  const { data: linked, error } = await supabase
    .from('product_option_groups')
    .select('id')
    .eq('variant_group_id', group.id);
  if (error) throw new Error(error.message);
  const ids = (linked || []).map((r) => r.id);
  if (!ids.length) return 0;
  const { error: updateError } = await supabase
    .from('product_option_groups')
    .update({ name: group.name, is_required: group.is_required, max_select: group.max_select })
    .in('id', ids);
  if (updateError) throw new Error(updateError.message);
  const { error: deleteError } = await supabase.from('product_options').delete().in('group_id', ids);
  if (deleteError) throw new Error(deleteError.message);
  const rows = ids.flatMap((groupId) =>
    group.options.map((o, oi) => ({ ...o, group_id: groupId, display_order: oi })),
  );
  for (let i = 0; i < rows.length; i += 500) {
    const { error: insertError } = await supabase.from('product_options').insert(rows.slice(i, i + 500));
    if (insertError) throw new Error(insertError.message);
  }
  return ids.length;
}

/**
 * For a product save: groups that point at one of this store's saved
 * variants take the saved name and options (the client only sends the id).
 * A link to another store's group (e.g. a product copied between stores)
 * is dropped and the group is kept as a plain copy.
 */
export async function resolveLinkedGroups(storeId, groups) {
  const list = Array.isArray(groups) ? groups : [];
  const ids = [...new Set(list.map((g) => g?.variant_group_id).filter(Boolean).map(String))];
  if (!ids.length) return list.map(({ variant_group_id: _drop, ...g }) => g);
  let saved = new Map();
  if (storeId) {
    const { data, error } = await supabase.from(TABLE).select(SELECT).eq('store_id', storeId).in('id', ids);
    if (error && !isMissingTable(error)) throw new Error(error.message);
    saved = new Map((data || []).map((row) => [String(row.id), row]));
  }
  return list.map((g) => {
    const row = g?.variant_group_id ? saved.get(String(g.variant_group_id)) : null;
    if (!row) {
      const { variant_group_id: _drop, ...plain } = g || {};
      return plain;
    }
    return {
      variant_group_id: row.id,
      name: row.name,
      is_required: !!row.is_required,
      max_select: row.max_select || 1,
      options: Array.isArray(row.options) ? row.options : [],
    };
  });
}

function routes(app, prefix, guard, canUseStore) {
  const base = `${prefix}/stores/:storeId/variant-groups`;

  const withStore = (handler) => async (req, res) => {
    try {
      if (!(await canUseStore(req, req.params.storeId))) {
        return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
      }
      return await handler(req, res);
    } catch (error) {
      if (isMissingTable(error)) return notSetUp(res);
      console.error(`${req.method} ${base} error:`, error);
      return res.status(500).json({ error: 'Could not save variants', details: error.message || 'Try again later' });
    }
  };

  app.get(base, guard, withStore(async (req, res) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT)
      .eq('store_id', req.params.storeId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      if (isMissingTable(error)) return res.json({ variant_groups: [], setup_required: true });
      throw new Error(error.message);
    }
    const usage = await usageCounts((data || []).map((r) => r.id));
    return res.json({ variant_groups: (data || []).map((r) => present(r, usage)) });
  }));

  app.post(base, guard, withStore(async (req, res) => {
    const group = normalizeVariantGroup(req.body);
    if (group.error) return res.status(400).json({ error: group.error });
    const { count } = await supabase.from(TABLE).select('id', { count: 'exact', head: true }).eq('store_id', req.params.storeId);
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ ...group, store_id: req.params.storeId, display_order: count || 0 })
      .select(SELECT)
      .single();
    if (error) throw error;
    return res.status(201).json({ variant_group: present(data, new Map()) });
  }));

  app.patch(`${base}/:groupId`, guard, withStore(async (req, res) => {
    const group = normalizeVariantGroup(req.body);
    if (group.error) return res.status(400).json({ error: group.error });
    const { data, error } = await supabase
      .from(TABLE)
      .update({ ...group, updated_at: new Date().toISOString() })
      .eq('id', req.params.groupId)
      .eq('store_id', req.params.storeId)
      .select(SELECT)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Variant group not found' });
    const updatedProducts = await syncLinkedProducts({ ...data, ...group });
    return res.json({ variant_group: present(data, new Map([[data.id, updatedProducts]])), updated_products: updatedProducts });
  }));

  app.delete(`${base}/:groupId`, guard, withStore(async (req, res) => {
    // ON DELETE CASCADE removes each product's linked copy and its options.
    const { data, error } = await supabase
      .from(TABLE)
      .delete()
      .eq('id', req.params.groupId)
      .eq('store_id', req.params.storeId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Variant group not found' });
    return res.json({ success: true });
  }));
}

export function registerVariantLibraryRoutes(app, { requireAdmin, requireAuth }) {
  routes(app, '/admin', requireAdmin, async () => true);
  routes(app, '/merchant', requireAuth, async (req, storeId) => {
    const { data } = await supabase.from('stores').select('merchant_id').eq('id', storeId).maybeSingle();
    return !!data && data.merchant_id === req.userId;
  });
}
