/**
 * Merchant Help & FAQ content served by GET /merchant/help (not hardcoded in the app).
 * Update this file to change copy without shipping a new mobile build for FAQ text
 * (clients still need to refetch).
 */

export const MERCHANT_QUICK_ACTIONS = [
  { id: 'orders', title: 'Order issues', icon: 'package', category: 'orders' },
  { id: 'payments', title: 'Payment issues', icon: 'credit-card', category: 'payments' },
  { id: 'riders', title: 'Rider issues', icon: 'truck', category: 'riders' },
  { id: 'account', title: 'Store & account', icon: 'home', category: 'account' },
];

/** @type {Array<{ id: string; category: string; question: string; answer: string; keywords?: string[] }>} */
export const MERCHANT_FAQS = [
  {
    id: 'faq-payouts',
    category: 'payments',
    question: 'How do payouts work?',
    answer:
      'Earnings from completed orders are reflected in your merchant wallet. Withdrawals are processed according to your region’s schedule; you can review balance and history in Wallet. If a payout fails, check that your business details are complete in Business Profile.',
    keywords: ['payout', 'wallet', 'money', 'withdraw', 'earn'],
  },
  {
    id: 'faq-products',
    category: 'account',
    question: 'How do I add or edit products?',
    answer:
      'Open Products / Menu from More, tap + to add an item, or tap a product to edit. Choose a category, set price and availability, and upload a photo. Changes save to your store menu for customers.',
    keywords: ['menu', 'product', 'add', 'price', 'category'],
  },
  {
    id: 'faq-hours',
    category: 'account',
    question: 'How do I change opening hours?',
    answer:
      'Go to Business Profile and update Operating hours. Your store’s open/closed state for customers follows those hours together with your store active status.',
    keywords: ['hours', 'open', 'closed', 'schedule', 'time'],
  },
  {
    id: 'faq-ready',
    category: 'orders',
    question: 'What does “Ready” mean?',
    answer:
      'When an order is prepared, mark it Ready so the customer and courier know it can be picked up. This helps track prep time and reduces wait at the counter.',
    keywords: ['ready', 'preparing', 'status', 'pickup'],
  },
  {
    id: 'faq-riders',
    category: 'riders',
    question: 'How are riders assigned?',
    answer:
      'Couriers accept open delivery jobs from the pool. Assignment depends on availability, distance, and platform rules. You’ll see rider status on the order when one is assigned.',
    keywords: ['rider', 'courier', 'delivery', 'assign'],
  },
  {
    id: 'faq-order-wrong',
    category: 'orders',
    question: 'A customer reported a wrong or missing item',
    answer:
      'Check the order details in your dashboard. If you need platform help, submit a request with the order reference. We may ask for photos or a short description.',
    keywords: ['wrong', 'missing', 'refund', 'complaint'],
  },
  {
    id: 'faq-charge',
    category: 'payments',
    question: 'I was charged incorrectly on a transaction',
    answer:
      'Note the payment reference and time, then contact support with your store name. We’ll cross-check with payment provider records.',
    keywords: ['charge', 'payment', 'pesepay', 'fee'],
  },
];

export function getMerchantHelpPayload() {
  return {
    quickActions: MERCHANT_QUICK_ACTIONS,
    faqs: MERCHANT_FAQS,
  };
}
