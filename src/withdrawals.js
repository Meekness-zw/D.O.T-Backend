/**
 * Wallet withdrawals: a courier (or merchant) asks for their balance, and the
 * admin and accountant pay it from the dashboard to the account the user set up.
 *
 * No payout API is connected, so the money moves outside the app. These
 * helpers find where it should go.
 */
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
