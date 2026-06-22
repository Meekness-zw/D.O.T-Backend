/**
 * Pesepay decryption diagnostic.
 * Run: node backend/testDecrypt.mjs
 *
 * This tries every reasonable key/IV combination against the real check-payment
 * payload captured from Render logs, so we can identify exactly which scheme
 * Pesepay's sandbox uses without another deploy cycle.
 */

import CryptoJS from 'crypto-js';

// ─── Keys from backend/.env ──────────────────────────────────────────────────
const ENC_KEY = 'c11c238a5962485a9cdcff368b116909'; // PAYMENT_ENCRYPTION_KEY
const INT_KEY = '66223ee8-050b-4f30-95af-40cfeb5d3acd'; // PAYMENT_INTEGRATION_ID

// ─── Full payload captured from Render logs ──────────────────────────────────
const PAYLOAD = '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';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function attempt(label, fn) {
  try {
    const words = fn();
    const utf8 = words.toString(CryptoJS.enc.Utf8);
    if (utf8 && utf8.trim()) {
      console.log(`\n✅ SUCCESS: ${label}`);
      console.log(`   → ${utf8.slice(0, 400)}`);
      return true;
    }
  } catch (_) {}
  console.log(`❌ ${label}`);
  return false;
}

function attemptHex(label, fn) {
  try {
    const words = fn();
    const hex = words.toString(CryptoJS.enc.Hex);
    const preview = Buffer.from(hex, 'hex').slice(0, 32).toString('hex');
    console.log(`?? ${label} → first 32 bytes hex: ${preview}`);
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`);
  }
}

const clean = PAYLOAD.replace(/\s+/g, '');
const decoded = CryptoJS.enc.Base64.parse(clean);
console.log(`Payload: ${clean.length} base64 chars → ${decoded.sigBytes} raw bytes (${decoded.sigBytes / 16} AES blocks)`);
console.log(`ENC_KEY: "${ENC_KEY}" (${ENC_KEY.length} chars)`);
console.log(`INT_KEY: "${INT_KEY}" (${INT_KEY.length} chars)\n`);

// Pre-compute key material
const kEncUtf8   = CryptoJS.enc.Utf8.parse(ENC_KEY);
const ivEncUtf8  = CryptoJS.enc.Utf8.parse(ENC_KEY.slice(0, 16));
const kEncHex    = CryptoJS.enc.Hex.parse(ENC_KEY);              // AES-128 (hex-decoded)
const zeroIv     = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
const ikNoHyph   = INT_KEY.replace(/-/g, '');                    // 32 chars
const kIkUtf8    = CryptoJS.enc.Utf8.parse(ikNoHyph);
const ivIkUtf8   = CryptoJS.enc.Utf8.parse(ikNoHyph.slice(0, 16));
const ikFirst32  = INT_KEY.slice(0, 32);                          // with hyphens, first 32 chars
const kIkF32Utf8 = CryptoJS.enc.Utf8.parse(ikFirst32);
const ivIkF32    = CryptoJS.enc.Utf8.parse(ikFirst32.slice(0, 16));

// Strip-prepended-IV ciphertext
const ivPrepended = CryptoJS.lib.WordArray.create(decoded.words.slice(0, 4), 16);
const ctNoPrepend = CryptoJS.lib.CipherParams.create({
  ciphertext: CryptoJS.lib.WordArray.create(decoded.words.slice(4), decoded.sigBytes - 16),
});

console.log('─── Testing all strategies ───\n');

// S1: Standard scheme (all official SDKs)
attempt('S1: AES-256-CBC, encKey UTF8, IV = encKey[:16] UTF8',
  () => CryptoJS.AES.decrypt(clean, kEncUtf8, { iv: ivEncUtf8, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S2: IV prepended + encKey
attempt('S2: AES-256-CBC, encKey UTF8, IV = first 16 bytes of ciphertext',
  () => CryptoJS.AES.decrypt(ctNoPrepend, kEncUtf8, { iv: ivPrepended, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S3: Zero IV + encKey
attempt('S3: AES-256-CBC, encKey UTF8, zero IV',
  () => CryptoJS.AES.decrypt(clean, kEncUtf8, { iv: zeroIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S4: ECB, no IV, encKey
attempt('S4: AES-256-ECB, encKey UTF8, no IV',
  () => CryptoJS.AES.decrypt(clean, kEncUtf8, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }));

// S5: Hex-decoded encKey (AES-128), key = IV
attempt('S5: AES-128-CBC, hex-decoded encKey, IV = key',
  () => CryptoJS.AES.decrypt(clean, kEncHex, { iv: kEncHex, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S6: Hex-decoded encKey (AES-128), zero IV
attempt('S6: AES-128-CBC, hex-decoded encKey, zero IV',
  () => CryptoJS.AES.decrypt(clean, kEncHex, { iv: zeroIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S7: intKey (no hyphens, 32 chars) as AES-256 key, first 16 as IV
attempt('S7: AES-256-CBC, intKey(no-hyphens) UTF8, IV = first 16',
  () => CryptoJS.AES.decrypt(clean, kIkUtf8, { iv: ivIkUtf8, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S8: intKey (first 32 chars WITH hyphens) as key
attempt('S8: AES-256-CBC, intKey(first 32 chars w/ hyphens) UTF8, IV = first 16',
  () => CryptoJS.AES.decrypt(clean, kIkF32Utf8, { iv: ivIkF32, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S9: IV prepended + intKey (no hyphens)
attempt('S9: AES-256-CBC, intKey(no-hyphens) UTF8, IV = prepended',
  () => CryptoJS.AES.decrypt(ctNoPrepend, kIkUtf8, { iv: ivPrepended, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S10: encKey as hex-decoded AES-128, IV prepended
attempt('S10: AES-128-CBC, hex-decoded encKey, IV = prepended',
  () => CryptoJS.AES.decrypt(ctNoPrepend, kEncHex, { iv: ivPrepended, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// S11: No padding (to reveal what the raw decrypted bytes look like)
attemptHex('S11 (hex peek): AES-256-CBC, encKey UTF8, fixed IV, NoPadding',
  () => CryptoJS.AES.decrypt(clean, kEncUtf8, { iv: ivEncUtf8, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.NoPadding }));

// S12: intKey (no hyphens) zero IV
attempt('S12: AES-256-CBC, intKey(no-hyphens) UTF8, zero IV',
  () => CryptoJS.AES.decrypt(clean, kIkUtf8, { iv: zeroIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

// ─── Extended: MD5 / SHA256 key derivations ──────────────────────────────────
console.log('\n─── Extended: hashed-key strategies ───\n');

// MD5 of encKey string → 16 bytes (AES-128)
const md5EncKey = CryptoJS.MD5(ENC_KEY);
const md5IntKey = CryptoJS.MD5(INT_KEY);
const md5IntKeyNH = CryptoJS.MD5(INT_KEY.replace(/-/g, ''));

// SHA256 of encKey → 32 bytes (AES-256)
const sha256EncKey = CryptoJS.SHA256(ENC_KEY);
const sha256IntKey = CryptoJS.SHA256(INT_KEY);

// Hex-decoded integration key (no hyphens = 32 hex chars = 16 bytes → AES-128)
const kIHex = CryptoJS.enc.Hex.parse(INT_KEY.replace(/-/g, ''));

attempt('S13: AES-128-CBC, MD5(encKey), IV=MD5(encKey)',
  () => CryptoJS.AES.decrypt(clean, md5EncKey, { iv: md5EncKey, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S14: AES-128-CBC, MD5(encKey), IV=zeros',
  () => CryptoJS.AES.decrypt(clean, md5EncKey, { iv: zeroIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S15: AES-128-CBC, MD5(intKey), IV=MD5(intKey)',
  () => CryptoJS.AES.decrypt(clean, md5IntKey, { iv: md5IntKey, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S16: AES-128-CBC, MD5(intKey no-hyphens), IV=key',
  () => CryptoJS.AES.decrypt(clean, md5IntKeyNH, { iv: md5IntKeyNH, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S17: AES-256-CBC, SHA256(encKey), IV=first16 of SHA256',
  () => {
    const iv17 = CryptoJS.lib.WordArray.create(sha256EncKey.words.slice(0, 4), 16);
    return CryptoJS.AES.decrypt(clean, sha256EncKey, { iv: iv17, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
  });

attempt('S18: AES-256-CBC, SHA256(intKey), IV=first16 of SHA256',
  () => {
    const iv18 = CryptoJS.lib.WordArray.create(sha256IntKey.words.slice(0, 4), 16);
    return CryptoJS.AES.decrypt(clean, sha256IntKey, { iv: iv18, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
  });

attempt('S19: AES-128-CBC, hex-decoded intKey(no-hyphens), IV=key',
  () => CryptoJS.AES.decrypt(clean, kIHex, { iv: kIHex, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S20: AES-128-CBC, hex-decoded intKey(no-hyphens), IV=zeros',
  () => CryptoJS.AES.decrypt(clean, kIHex, { iv: zeroIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S21: AES-128-CBC, hex-decoded intKey, IV=prepended',
  () => CryptoJS.AES.decrypt(ctNoPrepend, kIHex, { iv: ivPrepended, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }));

attempt('S22: AES-128-ECB, MD5(encKey)',
  () => CryptoJS.AES.decrypt(clean, md5EncKey, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }));

attempt('S23: AES-128-ECB, hex-decoded intKey',
  () => CryptoJS.AES.decrypt(clean, kIHex, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }));

// Peek at hex-decoded intKey to compare byte patterns
peekHex('S19-noPad peek: AES-128-CBC, hex-intKey, IV=key, NoPadding',
  () => CryptoJS.AES.decrypt(clean, kIHex, { iv: kIHex, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.NoPadding }));

console.log('\n─── Done ───');
console.log('If ALL failed → the payload was encrypted by a key not derivable from the known keys.');
console.log('Most likely cause: Render PAYMENT_ENCRYPTION_KEY is set to a different value.');
console.log('Action: in Render dashboard check Environment → PAYMENT_ENCRYPTION_KEY matches the local .env exactly.');
