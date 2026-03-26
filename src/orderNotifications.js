/**
 * In-app notifications (notifications table). Uses service-role Supabase client.
 * user_id must be auth.users / user_profiles id (same as customers.id).
 */

export async function insertUserNotification(
  supabase,
  { userId, title, message, type = 'order', referenceId = null },
) {
  if (!supabase || !userId || !title || !message) return;
  const { error } = await supabase.from('notifications').insert({
    user_id: userId,
    title: String(title).slice(0, 200),
    message: String(message).slice(0, 2000),
    type,
    reference_id: referenceId,
  });
  if (error) console.error('[notifications] insert failed:', error.message || error);
}

export async function notifyCustomerMerchantOrderStatus(supabase, {
  customerId,
  orderId,
  orderNumber,
  status,
  storeName,
}) {
  if (!customerId || !status) return;
  const store = storeName || 'The restaurant';
  const numLabel = orderNumber ? `#${orderNumber}` : 'your order';

  const map = {
    confirmed: {
      title: 'Order confirmed',
      message: `${store} confirmed ${numLabel}.`,
    },
    preparing: {
      title: 'Preparing your order',
      message: `${store} is preparing ${numLabel}.`,
    },
    ready: {
      title: 'Order ready',
      message: `${numLabel} is ready for pickup. A driver will be assigned soon.`,
    },
    cancelled: {
      title: 'Order cancelled',
      message: `${numLabel} was cancelled by the store.`,
    },
  };

  const payload = map[status];
  if (!payload) return;

  await insertUserNotification(supabase, {
    userId: customerId,
    title: payload.title,
    message: payload.message,
    type: 'order',
    referenceId: orderId,
  });
}

export async function notifyCustomerCourierAssigned(supabase, {
  customerId,
  orderId,
  orderNumber,
  courierName,
}) {
  if (!customerId) return;
  const numLabel = orderNumber ? `#${orderNumber}` : 'your order';
  const who = courierName ? courierName : 'A driver';
  await insertUserNotification(supabase, {
    userId: customerId,
    title: 'Driver assigned',
    message: `${who} is on the way for ${numLabel}. You can track the delivery live.`,
    type: 'delivery',
    referenceId: orderId,
  });
}

export async function notifyCustomerOrderPlaced(supabase, {
  customerId,
  orderId,
  orderNumber,
  storeName,
  awaitingPayment,
}) {
  if (!customerId) return;
  const store = storeName || 'The store';
  const numLabel = orderNumber ? `#${orderNumber}` : 'your order';

  if (awaitingPayment) {
    await insertUserNotification(supabase, {
      userId: customerId,
      title: 'Complete payment',
      message: `Finish paying for ${numLabel} at ${store} to send it to the kitchen.`,
      type: 'payment',
      referenceId: orderId,
    });
    return;
  }

  await insertUserNotification(supabase, {
    userId: customerId,
    title: 'Order placed',
    message: `${numLabel} was sent to ${store}. You’ll get updates as it progresses.`,
    type: 'order',
    referenceId: orderId,
  });
}

export async function notifyCustomerPaymentReceived(supabase, {
  customerId,
  orderId,
  orderNumber,
  storeName,
}) {
  if (!customerId) return;
  const store = storeName || 'The store';
  const numLabel = orderNumber ? `#${orderNumber}` : 'your order';
  await insertUserNotification(supabase, {
    userId: customerId,
    title: 'Payment received',
    message: `${numLabel} is paid. ${store} will confirm your order soon.`,
    type: 'payment',
    referenceId: orderId,
  });
}

export async function notifyCustomerOrderSelfCancelled(supabase, {
  customerId,
  orderId,
  orderNumber,
}) {
  if (!customerId) return;
  const numLabel = orderNumber ? `#${orderNumber}` : 'Your order';
  await insertUserNotification(supabase, {
    userId: customerId,
    title: 'Order cancelled',
    message: `${numLabel} was cancelled. If you paid by wallet, your balance was refunded.`,
    type: 'order',
    referenceId: orderId,
  });
}
