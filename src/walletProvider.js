/**
 * Zimbabwean mobile money provider detection from phone number prefix.
 * Mirrors frontend/utils/walletProvider.js — keep both in sync.
 *
 * Used to label a customer's likely wallet provider in the UI
 * (GET /payments/wallet/detect-provider). The short `code` values
 * (EC/NM/TC/IB/OM) are retained for display/grouping only.
 */

export const WALLET_PROVIDERS = {
  ECOCASH:   { id: 'ecocash',  name: 'EcoCash',  code: 'EC' },
  ONEMONEY:  { id: 'onemoney', name: 'OneMoney', code: 'NM' },
  TELECASH:  { id: 'telecash', name: 'Telecash', code: 'TC' },
  INNBUCKS:  { id: 'innbucks', name: 'InnBucks', code: 'IB' },
  OMARI:     { id: 'omari',    name: "O'Mari",   code: 'OM' },
};

export function normalizeZwPhone(input) {
  const raw = String(input || '').replace(/\D/g, '');
  if (!raw) return '';
  if (raw.startsWith('263')) {
    const tail = raw.slice(3);
    return tail.startsWith('0') ? tail : `0${tail}`;
  }
  if (raw.startsWith('0')) return raw;
  if (raw.length === 9) return `0${raw}`;
  return raw;
}

export function detectProviderFromPhone(phone) {
  const local = normalizeZwPhone(phone);
  if (local.length < 4) return null;
  const prefix3 = local.slice(0, 3);
  if (prefix3 === '077' || prefix3 === '078') return { ...WALLET_PROVIDERS.ECOCASH,  confidence: 'high' };
  if (prefix3 === '071')                       return { ...WALLET_PROVIDERS.ONEMONEY, confidence: 'high' };
  if (prefix3 === '073')                       return { ...WALLET_PROVIDERS.TELECASH, confidence: 'high' };
  return null;
}

export function providerIdToCode(id) {
  const entry = Object.values(WALLET_PROVIDERS).find((p) => p.id === id);
  return entry?.code || null;
}

export function codeToProviderId(code) {
  const entry = Object.values(WALLET_PROVIDERS).find((p) => p.code === code);
  return entry?.id || null;
}
