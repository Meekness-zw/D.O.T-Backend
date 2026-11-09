/**
 * DOT team managing merchants' stores ("merchant control").
 *
 * Some merchants ask DOT to run their store. The admin team ticks "Managed by
 * DOT" on those merchants; a DOT staff account whose email is listed in
 * MERCHANT_CONTROLLER_EMAILS can then sign in to the merchant dashboard, switch
 * between those stores, and do what the merchant does there.
 *
 * Switching into a store issues an ordinary merchant access token for that
 * merchant, with an `act_by` claim naming the staff account, so every merchant
 * screen and endpoint works unchanged. A few things stay with the merchant:
 * where their money is paid out, withdrawals, their sign-in (PIN), and deleting
 * the account (see blockedWhileActing).
 */

export const DEFAULT_CONTROLLER_EMAILS = ['admin@deliveryontime.co.zw'];

/** How long a "switched into this store" token lasts. */
export const ACTING_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export function controllerEmails(env = process.env) {
  const raw = String(env.MERCHANT_CONTROLLER_EMAILS || '').trim();
  const list = raw ? raw.split(',') : DEFAULT_CONTROLLER_EMAILS;
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Whether this staff account may manage stores. */
export function isMerchantController(staffUser, env = process.env) {
  const email = String(staffUser?.email || '').trim().toLowerCase();
  return !!email && staffUser?.is_active !== false && controllerEmails(env).includes(email);
}

// What a DOT account may not do inside a merchant's store.
const BLOCKED = [
  { method: 'POST', path: /^\/merchants\/onboarding\/payout-method\/?$/ },
  { method: 'POST', path: /^\/wallet\/withdraw\/?$/ },
  { method: 'POST', path: /^\/payments\/wallet\/topup\/start\/?$/ },
  { method: 'DELETE', path: /^\/users\/me\/account\/?$/ },
  { method: 'POST', path: /^\/users\/me\/add-role\/?$/ },
  { method: '*', path: /^\/users\/me\/push-token\/?$/ },
  { method: '*', path: /^\/users\/me\/payment-methods(\/|$)/ },
  { method: 'POST', path: /^\/auth\/pin\/(set|biometric\/enable|biometric\/disable)\/?$/ },
];

/** Null if allowed, otherwise the reason shown to the DOT user. */
export function blockedWhileActing(method, path) {
  const m = String(method || '').toUpperCase();
  const hit = BLOCKED.find((rule) => (rule.method === '*' || rule.method === m) && rule.path.test(path));
  return hit
    ? 'Only the merchant can do this (payouts, withdrawals, their sign-in and deleting the account stay with them).'
    : null;
}

/** Orders a store still has to act on: paid and waiting for the merchant. */
export const NEW_ORDER_STATUSES = ['pending'];
