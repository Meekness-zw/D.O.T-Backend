export function isApprovedMerchant(merchant) {
  return (
    merchant?.approval_status === 'approved' &&
    merchant?.is_verified === true
  );
}

/**
 * Authorization middleware for merchant routes that touch a real, live order
 * (accepting it, confirming dispatch to a courier). Storefront setup
 * (onboarding, products, promotions, store profile) stays open under plain
 * requireAuth even while pending, since none of it is customer-visible until
 * /stores itself gates on approval_status — blocking it here would only slow
 * a merchant down building their catalog before their first review. This is
 * the narrower merchant counterpart to requireApprovedCourier, scoped to the
 * subset of actions that are actually operational: touching a paying
 * customer's order.
 */
export function createRequireApprovedMerchant({ client, logger = console } = {}) {
  return async function requireApprovedMerchant(req, res, next) {
    if (!client) {
      return res.status(500).json({
        error: 'Server not configured',
        details: 'Merchant approval could not be verified',
      });
    }

    try {
      const { data: merchant, error } = await client
        .from('merchants')
        .select('id, is_verified, approval_status')
        .eq('id', req.userId)
        .maybeSingle();

      if (error) throw error;

      if (!merchant) {
        return res.status(403).json({
          error: 'Forbidden',
          details: 'User is not a merchant',
        });
      }

      if (!isApprovedMerchant(merchant)) {
        return res.status(403).json({
          error: 'Merchant approval required',
          details: 'Your merchant account must be approved before you can manage live orders.',
          approvalStatus: merchant.approval_status || 'pending',
        });
      }

      req.approvedMerchant = merchant;
      return next();
    } catch (error) {
      logger.error?.('requireApprovedMerchant error:', error);
      return res.status(500).json({
        error: 'Failed to verify merchant approval',
        details: 'Please try again later',
      });
    }
  };
}
