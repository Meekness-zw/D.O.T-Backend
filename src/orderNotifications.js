/**
 * In-app notifications (notifications table). Uses service-role Supabase client.
 * user_id must be auth.users / user_profiles id (same as customers.id).
 *
 * Every notification:
 *  - carries an `audience` ('customer' | 'merchant' | 'courier') inside the
 *    data jsonb, so the app can show only the notifications that belong to
 *    the role the user is currently signed in as; and
 *  - is also delivered as a system push notification to the user's device,
 *    so it pops up even when the app is closed or backgrounded.
 */

import axios from 'axios';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Fire an Expo push to one user's registered device (best-effort). */
async function sendPushToUser(supabase, userId, { title, message, type, referenceId, data }) {
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('push_token')
      .eq('id', userId)
      .maybeSingle();
    const token = profile?.push_token;
    if (!token || !token.startsWith('ExponentPushToken')) return;

    await axios.post(
      EXPO_PUSH_URL,
      [{
        to: token,
        title,
        body: message,
        sound: 'default',
        data: { type, referenceId, ...(data || {}) },
      }],
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 },
    );
  } catch (err) {
    console.warn('[Push] send failed for user', userId, err?.message);
  }
}

export async function insertUserNotification(
  supabase,
  { userId, title, message, type = 'order', referenceId = null, data = null, audience = 'customer', push = true },
) {
  if (!supabase || !userId || !title || !message) return;

  const mergedData = { ...(data || {}), audience };

  const { error } = await supabase.from('notifications').insert({
    user_id: userId,
    title: String(title).slice(0, 200),
    message: String(message).slice(0, 2000),
    type,
    reference_id: referenceId,
    data: mergedData,
  });
  if (error) console.error('[notifications] insert failed:', error.message || error);

  if (push) {
    await sendPushToUser(supabase, userId, { title, message, type, referenceId, data: mergedData });
  }
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
    audience: 'customer',
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
    audience: 'customer',
  });
}

export async function notifyCustomerOrderPlaced(supabase, {
  customerId,
  orderId,
  orderNumber,
  storeName,
  awaitingPayment,
  paymentMethod = null,
  totalAmount = null,
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
      audience: 'customer',
      data: {
        orderId,
        orderNumber,
        storeName: store,
        paymentMethod,
        totalAmount,
        awaitingPayment: true,
      },
    });
    return;
  }

  await insertUserNotification(supabase, {
    userId: customerId,
    title: 'Order placed',
    message: `${numLabel} was sent to ${store}. You'll get updates as it progresses.`,
    type: 'order',
    referenceId: orderId,
    audience: 'customer',
    data: { orderId, orderNumber, storeName: store },
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
    audience: 'customer',
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
    audience: 'customer',
  });
}

/** Merchant-facing inventory alerts (low stock / out of stock). */
export async function notifyMerchantStockLevel(supabase, {
  merchantId,
  productId,
  productName,
  stockQuantity,
  outOfStock,
}) {
  if (!merchantId || !productName) return;
  await insertUserNotification(supabase, {
    userId: merchantId,
    title: outOfStock ? 'Out of stock — item disabled' : 'Low stock warning',
    message: outOfStock
      ? `"${productName}" is out of stock and has been automatically marked unavailable.`
      : `"${productName}" is running low — ${stockQuantity} left in stock.`,
    type: 'system',
    referenceId: productId,
    audience: 'merchant',
    data: { productId, productName, stockQuantity },
  });
}
