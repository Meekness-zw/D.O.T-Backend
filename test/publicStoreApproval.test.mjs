/**
 * Customer-facing store routes must fail closed until the owning merchant is
 * explicitly approved. Store.is_active is not an approval signal: onboarding
 * creates an active store before the admin has reviewed the application.
 *
 * These source-level checks intentionally guard the PostgREST query itself.
 * Filtering after pagination would let pending stores consume page slots, and
 * filtering only in the mobile app would leave direct menu/order URLs open.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const approvalRlsMigration = readFileSync(
  new URL('../migrations/2026-09-16-gate-public-stores-by-merchant-approval.sql', import.meta.url),
  'utf8',
);

function route(method, path, nextMarker) {
  const marker = `app.${method}('${path}'`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `expected ${method.toUpperCase()} ${path}`);
  const end = src.indexOf(nextMarker, start + marker.length);
  assert.ok(end > start, `expected marker after ${method.toUpperCase()} ${path}: ${nextMarker}`);
  return src.slice(start, end);
}

function assertDirectMerchantApprovalGate(routeSource) {
  assert.match(routeSource, /merchants!inner\s*\(/, 'merchant relation must be an inner join');
  assert.match(
    routeSource,
    /\.eq\(\s*['"]merchants\.is_active['"]\s*,\s*true\s*\)/,
    'merchant must be active',
  );
  assert.match(
    routeSource,
    /\.eq\(\s*['"]merchants\.approval_status['"]\s*,\s*['"]approved['"]\s*\)/,
    'merchant must be explicitly approved',
  );
}

test('public store listing only queries stores owned by approved merchants', () => {
  const source = route('get', '/stores', '// ─────────────────────────────────────────────────────────────────────────────');
  assertDirectMerchantApprovalGate(source);
});

test('direct public menu access is unavailable before merchant approval', () => {
  const source = route('get', '/stores/:storeId/menu', "app.get('/stores/:storeId/delivery-fee'");
  assertDirectMerchantApprovalGate(source);
});

test('direct delivery quotes are unavailable before merchant approval', () => {
  const source = route('get', '/stores/:storeId/delivery-fee', "app.patch('/merchant/products/reorder'");
  assertDirectMerchantApprovalGate(source);
});

test('order creation rejects stores owned by unapproved merchants', () => {
  const source = route('post', '/orders', "app.get('/merchant/dashboard-stats'");
  assertDirectMerchantApprovalGate(source);
});

test('public promotions only query active stores owned by approved merchants', () => {
  const source = route('get', '/public/promotions', "app.get('/merchant/promotions'");
  assert.match(source, /stores!inner\s*\(/, 'store relation must be an inner join');
  assert.match(source, /merchants!inner\s*\(/, 'merchant relation must be an inner join');
  assert.match(source, /\.eq\(\s*['"]stores\.is_active['"]\s*,\s*true\s*\)/);
  assert.match(source, /\.eq\(\s*['"]stores\.merchants\.is_active['"]\s*,\s*true\s*\)/);
  assert.match(
    source,
    /\.eq\(\s*['"]stores\.merchants\.approval_status['"]\s*,\s*['"]approved['"]\s*\)/,
  );
});

test('database RLS independently gates anon store and product reads', () => {
  assert.match(
    approvalRlsMigration,
    /CREATE OR REPLACE FUNCTION public\.is_merchant_approved_for_public_store[\s\S]*SECURITY DEFINER/,
  );
  assert.match(
    approvalRlsMigration,
    /SET search_path = public, pg_temp/,
    'security-definer helper must use a fixed search path',
  );
  assert.match(
    approvalRlsMigration,
    /REVOKE ALL ON FUNCTION public\.is_merchant_approved_for_public_store\(UUID\) FROM PUBLIC/,
  );

  const helperUses = approvalRlsMigration.match(/is_merchant_approved_for_public_store\(/g) || [];
  assert.ok(helperUses.length >= 5, 'helper must gate both store and product policies');
  assert.match(approvalRlsMigration, /merchant\.approval_status = 'approved'/);
  assert.match(approvalRlsMigration, /merchant\.is_active IS TRUE/);
});
