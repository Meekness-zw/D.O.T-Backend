/**
 * Where a merchant stands in onboarding, as /merchant/onboarding-status reports it.
 *
 * A merchant who asked the DOT team to set their store up has finished their
 * part (onboardingComplete), so every app and web screen sends them to the
 * review page. They are not treated as approved until the store exists, even
 * if the team approves the account first, since there is nothing to run yet.
 */
export function merchantOnboardingState({ isMerchant, hasStore, approvalStatus, storeSetupRequestedAt }) {
  const storeSetupRequested = isMerchant && !!storeSetupRequestedAt;
  const awaitingStoreSetup = storeSetupRequested && !hasStore;
  const status = approvalStatus || 'pending';
  return {
    onboardingComplete: isMerchant && (hasStore || storeSetupRequested),
    storeSetupRequested,
    awaitingStoreSetup,
    approvalStatus: status,
    isApproved: status === 'approved' && !awaitingStoreSetup,
    isRejected: status === 'rejected',
  };
}

export const STORE_SETUP_NOTE_MAX = 500;
