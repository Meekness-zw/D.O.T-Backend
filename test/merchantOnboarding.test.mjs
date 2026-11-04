import assert from 'node:assert/strict';
import { test } from 'node:test';

const { merchantOnboardingState } = await import('../src/merchantOnboarding.js');

test('no store and no request: still onboarding', () => {
  const s = merchantOnboardingState({ isMerchant: true, hasStore: false, approvalStatus: 'pending' });
  assert.equal(s.onboardingComplete, false);
  assert.equal(s.awaitingStoreSetup, false);
});

test('asked DOT to set up the store: goes to the review page, not the dashboard', () => {
  const s = merchantOnboardingState({
    isMerchant: true, hasStore: false, approvalStatus: 'pending', storeSetupRequestedAt: '2026-11-04T08:00:00Z',
  });
  assert.equal(s.onboardingComplete, true);
  assert.equal(s.awaitingStoreSetup, true);
  assert.equal(s.isApproved, false);
});

test('approved before the team created the store: still waits', () => {
  const s = merchantOnboardingState({
    isMerchant: true, hasStore: false, approvalStatus: 'approved', storeSetupRequestedAt: '2026-11-04T08:00:00Z',
  });
  assert.equal(s.isApproved, false);
  assert.equal(s.approvalStatus, 'approved');
});

test('store created and approved: proceeds', () => {
  const s = merchantOnboardingState({
    isMerchant: true, hasStore: true, approvalStatus: 'approved', storeSetupRequestedAt: '2026-11-04T08:00:00Z',
  });
  assert.equal(s.onboardingComplete, true);
  assert.equal(s.awaitingStoreSetup, false);
  assert.equal(s.isApproved, true);
});

test('merchants who set up their own store are unchanged', () => {
  assert.deepEqual(
    merchantOnboardingState({ isMerchant: true, hasStore: true, approvalStatus: 'approved' }),
    { onboardingComplete: true, storeSetupRequested: false, awaitingStoreSetup: false, approvalStatus: 'approved', isApproved: true, isRejected: false },
  );
  assert.equal(merchantOnboardingState({ isMerchant: false, hasStore: false }).onboardingComplete, false);
});
