/**
 * Map saved customer_payment_methods (provider + type) to Pesepay paymentMethodCode.
 * Aligns with wallet top-up (ZWL): Ecocash PZW211, OneMoney PZW212.
 * USD checkout uses env overrides — set in Pesepay dashboard.
 */

export function buildPhoneForPesepayCustomer(row) {
  if (!row?.phone_number) return null;
  const digits = String(row.phone_number).replace(/\D/g, '');
  if (!digits) return null;
  let cc = (row.phone_country_code || '+263').trim();
  if (!cc.startsWith('+')) {
    cc = `+${cc.replace(/^\+/, '')}`;
  }
  if (digits.length >= 11 && digits.startsWith('263')) {
    return `+${digits}`;
  }
  return `${cc}${digits}`;
}

export function resolvePesepayPaymentMethodCode({ currencyCode = 'USD', type, provider }) {
  const c = String(currencyCode || 'USD').toUpperCase();
  const p = String(provider || '').toLowerCase();
  const t = String(type || '').toLowerCase();

  const usdDefault =
    process.env.PESEPAY_USD_PAYMENT_METHOD_CODE ||
    process.env.PAYMENT_USD_METHOD_CODE ||
    null;

  if (c === 'ZWL') {
    if (p.includes('eco')) return process.env.PESEPAY_ZWL_ECOCASH_CODE || 'PZW211';
    if (p.includes('one')) return process.env.PESEPAY_ZWL_ONEMONEY_CODE || 'PZW212';
    if (p.includes('inn')) return process.env.PESEPAY_ZWL_INNBUCKS_CODE || usdDefault || 'PZW211';
    return process.env.PESEPAY_ZWL_DEFAULT_CODE || 'PZW211';
  }

  if (c === 'USD') {
    if (t === 'card') {
      return (
        process.env.PESEPAY_USD_CARD_METHOD_CODE ||
        usdDefault ||
        null
      );
    }
    if (t === 'mobile_money') {
      if (p.includes('eco')) {
        return process.env.PESEPAY_USD_ECOCASH_CODE || usdDefault;
      }
      if (p.includes('one')) {
        return process.env.PESEPAY_USD_ONEMONEY_CODE || usdDefault;
      }
      if (p.includes('inn')) {
        return process.env.PESEPAY_USD_INNBUCKS_CODE || usdDefault;
      }
      return usdDefault;
    }
  }

  return usdDefault;
}
