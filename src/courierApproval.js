export function isApprovedCourier(courier) {
  return (
    courier?.verification_status === 'approved' &&
    courier?.is_verified === true
  );
}

/**
 * Authorization middleware for courier-only operational routes.
 *
 * Keep this separate from authentication: pending couriers still need access
 * to onboarding, documents and /courier/onboarding-status while the admin is
 * reviewing them. Only delivery work is approval-gated.
 */
export function createRequireApprovedCourier({ client, logger = console } = {}) {
  return async function requireApprovedCourier(req, res, next) {
    if (!client) {
      return res.status(500).json({
        error: 'Server not configured',
        details: 'Courier approval could not be verified',
      });
    }

    try {
      const { data: courier, error } = await client
        .from('couriers')
        .select('id, is_verified, verification_status')
        .eq('id', req.userId)
        .maybeSingle();

      if (error) throw error;

      if (!courier) {
        return res.status(403).json({
          error: 'Forbidden',
          details: 'User is not a courier',
        });
      }

      if (!isApprovedCourier(courier)) {
        return res.status(403).json({
          error: 'Courier approval required',
          details: 'Your courier account must be approved before you can accept deliveries.',
          verificationStatus: courier.verification_status || 'pending',
        });
      }

      req.approvedCourier = courier;
      return next();
    } catch (error) {
      logger.error?.('requireApprovedCourier error:', error);
      return res.status(500).json({
        error: 'Failed to verify courier approval',
        details: 'Please try again later',
      });
    }
  };
}
