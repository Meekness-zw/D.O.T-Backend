/**
 * A customer may cancel an order the courier is still carrying once 60
 * minutes have passed since the store handed it over. They are refunded in
 * full to their wallet, the store is still paid for the food (by DOT, through
 * Settlements), and the courier earns nothing for the job.
 *
 * The clock starts at the merchant_confirmed entry in order_status_history,
 * the moment the store confirms handover. It stops counting once the courier
 * is at the door entering the delivery code (delivery_confirmation_pending).
 */
export const LATE_CANCEL_MINUTES = 60;
export const LATE_CANCEL_STATUSES = ['merchant_confirmed', 'picked_up', 'in_transit'];
// Written to order_status_history; Settlements finds late cancellations by it.
export const LATE_CANCEL_NOTE = 'Cancelled by customer: not delivered within 60 minutes of handover';

/** When each order was handed to the courier: Map(orderId → ISO time). */
export async function handoverTimes(client, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const { data, error } = await client
    .from('order_status_history')
    .select('order_id, created_at')
    .in('order_id', ids)
    .eq('status', 'merchant_confirmed')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message || 'Failed to load handover times');
  for (const row of data || []) {
    if (!out.has(row.order_id)) out.set(row.order_id, row.created_at);
  }
  return out;
}

/** When the customer may cancel (ISO), or null if this rule doesn't apply. */
export function lateCancelAvailableAt(status, handedOverAt) {
  if (!LATE_CANCEL_STATUSES.includes(String(status || '').toLowerCase())) return null;
  const t = Date.parse(handedOverAt || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t + LATE_CANCEL_MINUTES * 60 * 1000).toISOString();
}

/** Adds late_cancel_available_at to each order the courier is carrying. */
export async function attachLateCancel(client, orders) {
  const carrying = (orders || []).filter((o) => LATE_CANCEL_STATUSES.includes(String(o.status || '').toLowerCase()));
  if (!carrying.length) return orders;
  const times = await handoverTimes(client, carrying.map((o) => o.id));
  for (const o of carrying) o.late_cancel_available_at = lateCancelAvailableAt(o.status, times.get(o.id));
  return orders;
}
