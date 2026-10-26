/**
 * Wallet withdrawals: a courier (or merchant) asks for their balance, and the
 * admin and accountant pay it to the account the user set up.
 *
 * No payout API is connected, so the money moves outside the app. These
 * helpers find where it should go and tell staff a request is waiting.
 */
import { sendEmail, emailConfigured } from './mailer.js';
import { resolveCourierPayoutDestination } from './orderPaymentSplit.js';

export const MIN_WITHDRAWAL_USD = 20;

/**
 * Where a withdrawal for this user is paid: { kind, provider, accountNumber, ... }.
 * kind is 'courier' or 'company' (a company rider's money goes to their company),
 * 'merchant', or 'blocked' with a reason when there is nowhere to send it.
 */
export async function payoutDestinationFor(client, userId, role) {
  if (role === 'courier') return resolveCourierPayoutDestination(userId);

  const { data: method } = await client
    .from('merchant_payout_methods')
    .select('id, method_type, provider, provider_code, account_number, account_name')
    .eq('merchant_id', userId)
    .eq('is_default', true)
    .maybeSingle();
  if (!method?.account_number) return { kind: 'blocked', reason: 'no_payout_method' };
  return {
    kind: 'merchant',
    payoutMethodId: method.id,
    methodType: method.method_type,
    provider: method.provider,
    providerCode: method.provider_code,
    accountNumber: method.account_number,
    accountName: method.account_name,
  };
}

export const NO_DESTINATION_DETAILS = {
  no_payout_method: 'Add a payout account (e.g. EcoCash) before requesting a withdrawal.',
  company_inactive: 'Payouts to your courier company are switched off. Contact DOT support.',
  company_has_no_payout_method: 'Your courier company has no payout account on file. Ask them to add one.',
  paid_by_dot: 'DOT pays this rider directly. Job earnings are not withdrawn from the app.',
};

/** "EcoCash · 0771234567 · Jane Doe" */
export function describeDestination(dest) {
  if (!dest || dest.kind === 'blocked' || dest.kind === 'internal') return 'No payout account';
  const parts = [dest.provider || dest.methodType, dest.accountNumber, dest.accountName].filter(Boolean);
  const via = dest.kind === 'company' ? ` (courier company: ${dest.companyName})` : '';
  return parts.join(' · ') + via;
}

/**
 * Email every active admin and accountant that a request is waiting. Best
 * effort: the request is already saved and shows on the dashboard either way.
 */
export async function emailStaffAboutWithdrawal(client, { request, requesterName, destination }) {
  if (!emailConfigured()) return;
  const { data: staff, error } = await client
    .from('admin_users')
    .select('email')
    .in('role', ['admin', 'accountant'])
    .eq('is_active', true)
    .not('email', 'is', null);
  if (error) throw new Error(error.message || 'Failed to load staff emails');

  const amount = `$${Number(request.amount).toFixed(2)}`;
  const who = requesterName || 'A user';
  const role = request.role === 'courier' ? 'courier' : 'merchant';
  const subject = `Withdrawal request: ${amount} from ${who} (${role})`;
  const to = describeDestination(destination);
  const text =
    `${who} (${role}) asked to withdraw ${amount}.\n\n` +
    `Pay to: ${to}\n\n` +
    'Review it under Withdrawals in the DOT dashboard, send the money, then mark it paid.';
  const html =
    `<p><strong>${escapeHtml(who)}</strong> (${role}) asked to withdraw <strong>${amount}</strong>.</p>` +
    `<p>Pay to: <strong>${escapeHtml(to)}</strong></p>` +
    '<p>Review it under <strong>Withdrawals</strong> in the DOT dashboard, send the money, then mark it paid.</p>';

  const results = await Promise.allSettled(
    (staff || []).map((s) => sendEmail({ to: s.email, subject, html, text })),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.error(`withdrawal alert: ${failed} of ${results.length} staff emails failed`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
