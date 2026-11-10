import { supabaseAdmin as supabase } from './supabaseAdminClient.js';
import { ACTIVE_STATUSES } from './oversightService.js';

/**
 * Where couriers are, for the admin couriers map.
 *
 * Two sources: the position a courier reports while on a job (stored on the
 * order), and the courier's last position (couriers.last_*), which the app
 * also reports while the courier is online without a job. The fresher wins.
 */

/** A position older than this is shown as "last seen", not live. */
export const STALE_AFTER_MINUTES = 15;

/** Remember a courier's last position. Best-effort: never fails the caller. */
export async function saveCourierPosition(courierId, latitude, longitude) {
  if (!supabase || !courierId) return;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const { error } = await supabase
    .from('couriers')
    .update({ last_latitude: lat, last_longitude: lng, last_location_at: new Date().toISOString() })
    .eq('id', courierId);
  // Before migrations/2026-11-10-courier-last-position.sql the columns don't exist.
  if (error && !/last_(latitude|longitude|location_at)/i.test(error.message || '')) {
    console.warn('[courier-position] save failed:', error.message);
  }
}

/** Pick the fresher of two { lat, lng, at } positions (either may be null). */
export function fresherPosition(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(b.at).getTime() > new Date(a.at).getTime() ? b : a;
}

/** Every approved courier with where they were last seen. */
export async function getCourierMap({ dotOnly = false } = {}) {
  if (!supabase) throw new Error('Server not configured');

  let couriers = null;
  let withLastPosition = true;
  {
    const select = `id, is_online, is_verified, verification_status, payouts_enabled, company_id,
      last_latitude, last_longitude, last_location_at,
      user_profiles ( full_name, phone )`;
    const res = await supabase.from('couriers').select(select);
    if (res.error && /last_(latitude|longitude|location_at)/i.test(res.error.message || '')) {
      // Migration not run yet: job positions still work.
      withLastPosition = false;
      const retry = await supabase
        .from('couriers')
        .select('id, is_online, is_verified, verification_status, payouts_enabled, company_id, user_profiles ( full_name, phone )');
      if (retry.error) throw new Error(retry.error.message || 'Failed to load couriers');
      couriers = retry.data;
    } else if (res.error) {
      throw new Error(res.error.message || 'Failed to load couriers');
    } else {
      couriers = res.data;
    }
  }

  const approved = (couriers || []).filter(
    (c) => (c.verification_status === 'approved' || c.is_verified) && (!dotOnly || c.payouts_enabled === false),
  );
  const ids = approved.map((c) => c.id);

  const jobPosition = new Map();
  const onJob = new Set();
  if (ids.length) {
    const { data: orders } = await supabase
      .from('orders')
      .select('courier_id, order_number, courier_latitude, courier_longitude, courier_location_updated_at')
      .in('status', ACTIVE_STATUSES)
      .in('courier_id', ids)
      .order('courier_location_updated_at', { ascending: false });
    (orders || []).forEach((o) => {
      onJob.add(o.courier_id);
      if (jobPosition.has(o.courier_id) || o.courier_latitude == null) return;
      jobPosition.set(o.courier_id, {
        lat: Number(o.courier_latitude),
        lng: Number(o.courier_longitude),
        at: o.courier_location_updated_at,
        order_number: o.order_number,
      });
    });
  }

  const { data: companies } = await supabase.from('courier_companies').select('id, name');
  const companyName = new Map((companies || []).map((c) => [c.id, c.name]));

  const now = Date.now();
  const list = approved.map((c) => {
    const idle =
      withLastPosition && c.last_latitude != null && c.last_location_at
        ? { lat: Number(c.last_latitude), lng: Number(c.last_longitude), at: c.last_location_at }
        : null;
    const pos = fresherPosition(jobPosition.get(c.id) || null, idle);
    const ageMinutes = pos?.at ? Math.round((now - new Date(pos.at).getTime()) / 60000) : null;
    return {
      courier_id: c.id,
      name: c.user_profiles?.full_name || 'Courier',
      phone: c.user_profiles?.phone || null,
      is_dot: c.payouts_enabled === false,
      company: c.company_id ? companyName.get(c.company_id) || null : null,
      is_online: !!c.is_online,
      on_job: onJob.has(c.id),
      latitude: pos ? pos.lat : null,
      longitude: pos ? pos.lng : null,
      last_seen: pos?.at || null,
      last_seen_minutes: ageMinutes,
      stale: ageMinutes == null || ageMinutes > STALE_AFTER_MINUTES,
    };
  });

  return {
    couriers: list,
    counts: {
      total: list.length,
      dot: list.filter((c) => c.is_dot).length,
      online: list.filter((c) => c.is_online).length,
      on_job: list.filter((c) => c.on_job).length,
      located: list.filter((c) => c.latitude != null).length,
    },
    generated_at: new Date().toISOString(),
  };
}
