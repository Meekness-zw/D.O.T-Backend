/**
 * DOT support assistant.
 * Answers from a role-aware knowledge base and the caller's recent orders.
 * Escalates when the person asks for a human, or when the bot has no answer.
 */

const ESCALATE_RE =
  /\b(talk to|speak to|chat with|connect me|human|real person|live agent|customer service|representative|escalate|an agent|the agent|support team|someone from)\b/i;
const AFFIRM_RE = /^(yes|yeah|yep|yup|please|ok|okay|sure|connect me|do that|go ahead)\b/i;
const ORDER_CODE_RE = /DOT-[A-Z0-9]+/i;

const STATUS_LABELS = {
  awaiting_payment: 'waiting for payment before the store can start',
  pending: 'placed and waiting for the store',
  accepted: 'accepted by the store',
  preparing: 'being prepared by the store',
  ready: 'ready for a courier to collect',
  assigned: 'assigned to a courier who is heading to the store',
  courier_arrived: 'with a courier who has arrived at the store',
  merchant_confirmed: 'confirmed by the store for pickup',
  picked_up: 'collected and on the way',
  in_transit: 'on the way to the delivery address',
  on_the_way: 'on the way to the delivery address',
  delivered: 'delivered',
  completed: 'completed',
  cancelled: 'cancelled',
  refunded: 'refunded',
  declined: 'declined',
};

const PAYMENT_LABELS = {
  smilepay: 'Smile Cash (ZB, EcoCash, InnBucks, or card via ZB)',
  pesepay: 'Pesepay',
  wallet: 'in-app wallet',
  ecocash: 'EcoCash',
};

/** @type {Array<{ roles: string[]; keywords: string[]; answer: string }>} */
const ARTICLES = [
  {
    roles: ['customer'],
    keywords: ['place order', 'how to order', 'order food', 'add to cart', 'checkout', 'browse'],
    answer:
      'To place an order, open Home, pick a store, add items, then go to Checkout. Confirm the delivery address, choose Smile Cash or your wallet, and tap Place Order. You can also add a note for the rider or the store.',
  },
  {
    roles: ['customer'],
    keywords: ['track', 'where is', 'eta', 'courier location', 'delivery status', 'my order status'],
    answer:
      'Open Orders to follow a live order. You will see the status change as the store prepares it, a courier accepts it, and it is on the way. If you tell me an order number like #DOT-XXXX I can look it up on your account.',
  },
  {
    roles: ['customer'],
    keywords: ['cancel', 'cancellation', 'cancel order'],
    answer:
      'You can cancel an order from Orders while it is still waiting for payment or before the store has moved it far into preparation. Open the order and use Cancel. If the order is already with a courier, I can pass you to an agent so they can step in.',
  },
  {
    roles: ['customer', 'merchant', 'courier'],
    keywords: ['payment', 'pay', 'smile cash', 'smilepay', 'zb', 'innbucks', 'card'],
    answer:
      'Checkout uses Smile Cash by default: ZB Smile Cash, EcoCash, InnBucks, or card through ZB. You can also pay with your in-app wallet when the balance covers the order. Wallet top-ups still go through Pesepay. A direct EcoCash button is on checkout but is not switched on yet.',
  },
  {
    roles: ['customer'],
    keywords: ['ecocash'],
    answer:
      'EcoCash can already be used inside Smile Cash at checkout. The separate “Pay with EcoCash” option is on the screen, but it is not connected yet, so placing an order with that option will not charge you. Use Smile Cash or your wallet for now.',
  },
  {
    roles: ['customer', 'merchant', 'courier'],
    keywords: ['wallet', 'balance', 'top up', 'topup', 'top-up'],
    answer:
      'Your wallet balance is on the Wallet screen. Top up from there with Pesepay. Wallet payments at checkout are instant and do not redirect you. If the balance is short, the checkout screen tells you to top up or pick Smile Cash.',
  },
  {
    roles: ['customer'],
    keywords: ['refund', 'money back', 'charged twice', 'double charge'],
    answer:
      'If an order is cancelled before it is fulfilled, an eligible refund goes back to the original method. Wallet refunds show in Wallet history. Bank and mobile-money refunds follow that provider’s timeline. If a charge looks wrong, send me the order number and I can connect you with the team.',
  },
  {
    roles: ['customer'],
    keywords: ['address', 'deliver to', 'location', 'change address', 'saved address'],
    answer:
      'Set “Deliver to” on Home, or manage saved addresses from your profile. Checkout uses the address you picked. If a courier is already on the way, changing the address needs the support team, so ask me to talk to an agent.',
  },
  {
    roles: ['customer'],
    keywords: ['notification', 'notifications', 'not getting alerts'],
    answer:
      'The bell on Home opens Notifications. Unread items are marked there, and you can clear or mark them all read. Allow notifications for the app in your phone settings if alerts are not arriving.',
  },
  {
    roles: ['customer', 'merchant', 'courier'],
    keywords: ['account', 'profile', 'edit profile', 'phone number', 'password', 'delete account', 'sign out', 'log out'],
    answer:
      'Open Profile to edit your name and phone, switch role, or sign out. Password reset starts from the login screen with Forgot password. Account deletion is in profile settings and is permanent.',
  },
  {
    roles: ['customer'],
    keywords: ['area', 'coverage', 'where do you deliver', 'harare', 'zimbabwe', 'available'],
    answer:
      'Delivery On Time currently serves stores around Harare, Zimbabwe, and is expanding. If a store does not appear, it is outside the delivery range for the address on Home. Change “Deliver to” to check another area.',
  },
  {
    roles: ['customer'],
    keywords: ['promo', 'discount', 'coupon', 'hot deals', 'code'],
    answer:
      'Promo Hot Deals are on Home. At checkout, enter a discount code and tap Apply before placing the order. A code only works if it is still active and the order meets its rules.',
  },
  {
    roles: ['customer'],
    keywords: ['hours', 'support hours', 'what time', 'open'],
    answer:
      'Support hours are weekdays 8:00 AM to 10:00 PM, and weekends and holidays 9:00 AM to 9:00 PM (Harare time). You can still send a message outside those hours. Phone support is +263 78 801 9834 and email is support@deliveryontime.co.zw.',
  },
  {
    roles: ['customer'],
    keywords: ['contact', 'phone', 'call', 'email', 'whatsapp'],
    answer:
      'You can call +263 78 801 9834, email support@deliveryontime.co.zw, or message that number on WhatsApp. Those options are also under Contact Support. If you would rather stay in the app, say you want to talk to an agent and this chat is passed to the team.',
  },
  {
    roles: ['customer'],
    keywords: ['favourite', 'favorite', 'saved store'],
    answer:
      'Tap the heart on a store to save it. Saved stores are under Favourites in your profile so you can reorder from them quickly.',
  },
  {
    roles: ['customer'],
    keywords: ['missing item', 'wrong item', 'wrong order', 'cold food', 'complaint', 'damaged'],
    answer:
      'I am sorry that order was not right. Open Report an Issue from Help & Support, and include the order number plus a short description or photo. I can also pass this chat to an agent now if you want a person to look at it.',
  },
  {
    roles: ['merchant'],
    keywords: ['payout', 'withdraw', 'earnings', 'wallet', 'settlement'],
    answer:
      'Completed-order earnings land in your merchant wallet. Withdrawals follow the schedule for your region and need a payout method saved in Business Profile. If a payout fails, confirm the business and bank details, then ask for an agent if it still does not move.',
  },
  {
    roles: ['merchant'],
    keywords: ['product', 'menu', 'add item', 'price', 'category', 'photo'],
    answer:
      'Open Products or Menu from More. Tap + to add an item, or tap an item to edit the name, price, category, availability, and photo. Customers see the change on your store menu after it saves.',
  },
  {
    roles: ['merchant'],
    keywords: ['hours', 'opening', 'closed', 'open store', 'operating'],
    answer:
      'Update operating hours in Business Profile. Customers see the store as open only when those hours say so and the store is active.',
  },
  {
    roles: ['merchant'],
    keywords: ['ready', 'preparing', 'accept order', 'mark ready'],
    answer:
      'New paid orders show on your home screen. Accept and prepare them, then mark the order Ready so a courier can collect it. Ready tells the customer and the courier that the food is at the counter.',
  },
  {
    roles: ['merchant'],
    keywords: ['rider', 'courier', 'no courier', '45', 'repost', 'expired'],
    answer:
      'Couriers accept open jobs. If nobody accepts within 45 minutes, the order shows as expired and you can tap Repost to couriers while it is still preparing or ready. You do not need to recreate the order.',
  },
  {
    roles: ['merchant'],
    keywords: ['promotion', 'promo', 'discount', 'share products'],
    answer:
      'Store promotions are managed from Promotions in More. Platform discount codes are separate and are created by the DOT team. You can also share a product list with another store from Share products.',
  },
  {
    roles: ['merchant'],
    keywords: ['approval', 'pending', 'documents', 'onboarding', 'not live'],
    answer:
      'A new store stays pending until the DOT team approves the business documents. You will get a notification when it is approved or if something needs to be re-uploaded. Until then customers cannot place orders.',
  },
  {
    roles: ['courier'],
    keywords: ['accept', 'job', 'available', 'online', 'go online'],
    answer:
      'Turn availability on from the courier home screen. Open jobs appear based on distance. Accept one to see the store, the pickup, and the drop-off. You can drop a job before delivery has started if you cannot complete it.',
  },
  {
    roles: ['courier'],
    keywords: ['drop', 'cancel job', 'cannot deliver', 'unassign'],
    answer:
      'Before you start the delivery, use Drop job on the active order. The order goes back to couriers. Once you are on the way to the customer, contact support instead of dropping it.',
  },
  {
    roles: ['courier'],
    keywords: ['customer not responding', 'no answer', 'not picking', 'cannot find customer'],
    answer:
      'Wait a few minutes and call the customer from the order screen. If there is still no answer, message them in the order chat, then ask for an agent here so the team can decide the next step.',
  },
  {
    roles: ['courier'],
    keywords: ['earnings', 'payout', 'withdraw', 'paid', 'wallet'],
    answer:
      'Delivery earnings are added to your courier wallet after the order is completed. Add a payout method in your profile. Withdrawals follow the regional schedule and can take a few days to show in your account.',
  },
  {
    roles: ['courier'],
    keywords: ['document', 'verification', 'license', 'approve', 'rejected'],
    answer:
      'Upload a clear driver licence, vehicle documents, and a profile photo from the verification sections in your profile. Reviews usually take 24–48 hours. If something is rejected, the app tells you what to replace.',
  },
  {
    roles: ['courier'],
    keywords: ['vehicle', 'bike', 'car', 'equipment', 'bag'],
    answer:
      'Update your vehicle from Vehicle information and submit any documents the change needs. An insulated bag is recommended, and a phone mount helps if you are driving.',
  },
  {
    roles: ['customer', 'merchant', 'courier'],
    keywords: ['app not working', 'crash', 'bug', 'error', 'blank screen', 'cannot login', 'cannot log in', 'otp'],
    answer:
      'Close the app fully and open it again, and check that you are online. For login, request a new code and confirm the phone number. If it still fails, tell me what you see on the screen and I can pass this to an agent.',
  },
];

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || key.replace(/_/g, ' ') || 'updating';
}

function money(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `USD ${n.toFixed(2)}`;
}

export function describeOrder(order, role) {
  if (!order) return '';
  const number = order.order_number ? `#${order.order_number}` : 'This order';
  const status = statusLabel(order.status);
  const pay = PAYMENT_LABELS[String(order.payment_method || '').toLowerCase()] || order.payment_method;
  const total = money(order.total_amount);
  const bits = [`${number} is ${status}.`];
  if (pay) bits.push(`Payment method: ${pay}.`);
  if (order.payment_status) bits.push(`Payment status: ${String(order.payment_status).replace(/_/g, ' ')}.`);
  if (total) bits.push(`Total: ${total}.`);
  if (role === 'merchant' && ['assigned', 'pending', 'preparing', 'ready'].includes(String(order.status))) {
    bits.push('If no courier has accepted it after 45 minutes, repost it from your orders list.');
  }
  return bits.join(' ');
}

function bestArticle(text, role) {
  const hay = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const article of ARTICLES) {
    if (!article.roles.includes(role)) continue;
    let score = 0;
    for (const keyword of article.keywords) {
      if (hay.includes(keyword)) score += keyword.includes(' ') ? 3 : 2;
    }
    if (score > bestScore) {
      best = article;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

function summarizeOrders(orders, role) {
  if (!orders.length) {
    if (role === 'merchant') return 'I cannot see any recent orders for your store.';
    if (role === 'courier') return 'I cannot see any recent deliveries on your courier account.';
    return 'I cannot see any recent orders on your account.';
  }
  const lines = orders.slice(0, 3).map((order) => describeOrder(order, role));
  return lines.join('\n\n');
}

/**
 * @returns {{ text: string, escalate: boolean, offerAgent: boolean }}
 */
export function botReply({ text, role, orders = [], lastBotOfferedAgent = false }) {
  const q = String(text || '').trim();
  const safeRole = ['customer', 'merchant', 'courier'].includes(role) ? role : 'customer';

  if (ESCALATE_RE.test(q) || (lastBotOfferedAgent && AFFIRM_RE.test(q))) {
    return {
      escalate: true,
      offerAgent: false,
      text: 'I have passed this chat to the Delivery On Time team. An admin, marketer, or accountant will reply in this same conversation. You can keep sending details while you wait.',
    };
  }

  const code = q.match(ORDER_CODE_RE);
  if (code) {
    const wanted = code[0].toLowerCase();
    const match = orders.find((order) => String(order.order_number || '').toLowerCase() === wanted);
    if (match) {
      return { escalate: false, offerAgent: false, text: describeOrder(match, safeRole) };
    }
    return {
      escalate: false,
      offerAgent: true,
      text: `I could not find ${code[0]} on this account. Check the number in Orders, or say “talk to an agent” and the team will look it up.`,
    };
  }

  if (/\b(my orders|recent orders|order status|where is my|track my)\b/i.test(q)) {
    return { escalate: false, offerAgent: false, text: summarizeOrders(orders, safeRole) };
  }

  const article = bestArticle(q, safeRole);
  if (article) {
    return { escalate: false, offerAgent: false, text: article.answer };
  }

  if (/\b(order|delivery|payment|wallet|refund)\b/i.test(q) && orders.length) {
    return {
      escalate: false,
      offerAgent: true,
      text: `Here is the latest I can see:\n\n${summarizeOrders(orders, safeRole)}\n\nIf that is not what you needed, say “talk to an agent”.`,
    };
  }

  return {
    escalate: false,
    offerAgent: true,
    text: 'I do not have a specific answer for that. I can help with orders, payments, the wallet, deliveries, store menus, payouts, and account access. Say “talk to an agent” and I will hand this chat to the team.',
  };
}

export function greetingFor(role) {
  if (role === 'merchant') {
    return 'Hi, I am the DOT assistant for stores. Ask me about orders, marking an order ready, couriers, your menu, or payouts. Say “talk to an agent” if you want a person from the team.';
  }
  if (role === 'courier') {
    return 'Hi, I am the DOT assistant for couriers. Ask me about jobs, dropping a delivery, earnings, or document verification. Say “talk to an agent” if you want a person from the team.';
  }
  return 'Hi, I am the DOT assistant. Ask me about an order, a payment, your wallet, or your account. If I cannot solve it, say “talk to an agent” and I will pass this chat to the team.';
}
