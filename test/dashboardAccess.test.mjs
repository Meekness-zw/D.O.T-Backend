/**
 * Who can reach what, per dashboard role.
 *
 * The gate is lifted out of server.js by source rather than imported, because
 * importing server.js starts a listener. The thing under test is therefore the
 * thing that ships.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

function cut(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} unbalanced`);
}
const secStart = src.indexOf('const DASHBOARD_SECTIONS =');
const SECTIONS = eval('(' + src.slice(src.indexOf('{', secStart), src.indexOf('};', secStart) + 1) + ')');
const can = eval(`(${cut('dashboardRoleCanAccess')})`);

const CASES = [
  // ── Approvals: marketing recruits, so marketing clears applications ──────
  ['sales_marketing', 'GET',    '/admin/users/pending',              true ],
  ['sales_marketing', 'POST',   '/admin/couriers/abc/approve',       true ],
  ['sales_marketing', 'POST',   '/admin/merchants/abc/reject',       true ],
  ['accountant',      'GET',    '/admin/users/pending',              false],
  ['accountant',      'POST',   '/admin/couriers/abc/approve',       false],

  // Anchored, not prefixed: editing a merchant record is a different power
  // from clearing their application.
  ['sales_marketing', 'PATCH',  '/admin/merchants/abc',              false],
  ['sales_marketing', 'POST',   '/admin/couriers/abc/approve/extra', false],
  ['sales_marketing', 'POST',   '/admin/couriers/a/b/approve',       false],
  ['sales_marketing', 'DELETE', '/admin/couriers/abc/approve',       false],

  // ── Settlements: the accountant's job, nobody else's ─────────────────────
  ['accountant',      'GET',    '/admin/settlements',                true ],
  ['accountant',      'POST',   '/admin/settlements/abc/disburse',   true ],
  ['admin',           'POST',   '/admin/settlements/abc/disburse',   true ],
  ['sales_marketing', 'GET',    '/admin/settlements',                false],
  ['sales_marketing', 'POST',   '/admin/settlements/abc/disburse',   false],

  // ── Oversight is read-only and open to all three ─────────────────────────
  ['sales_marketing', 'GET',    '/admin/couriers/abc/oversight',     true ],
  ['accountant',      'GET',    '/admin/merchants/abc/oversight',    true ],

  // ── Companies: everyone reads, only admin writes ─────────────────────────
  ['accountant',      'GET',    '/admin/courier-companies',          true ],
  ['sales_marketing', 'GET',    '/admin/courier-companies',          true ],
  ['accountant',      'POST',   '/admin/courier-companies',          false],
  ['sales_marketing', 'POST',   '/admin/courier-companies',          false],
  ['accountant',      'PATCH',  '/admin/courier-companies/abc',      false],
  ['accountant',      'DELETE', '/admin/courier-companies/abc',      false],
  ['sales_marketing', 'PATCH',  '/admin/couriers/abc/company',       false],
  ['admin',           'POST',   '/admin/courier-companies',          true ],

  // ── Money and accounts stay shut to marketing ────────────────────────────
  ['sales_marketing', 'DELETE', '/admin/users/abc',                  false],
  ['sales_marketing', 'POST',   '/admin/users/abc/wallet-credit',    false],
  ['sales_marketing', 'PATCH',  '/admin/users/abc/suspend',          false],
  ['sales_marketing', 'POST',   '/admin/orders/abc/refund',          false],
  ['sales_marketing', 'GET',    '/admin/payments',                   false],
  ['sales_marketing', 'GET',    '/admin/quickbooks/status',          false],

  // ── Unchanged ────────────────────────────────────────────────────────────
  ['accountant',      'GET',    '/admin/payments',                   true ],
  ['accountant',      'POST',   '/admin/quickbooks/connect',         true ],
  ['admin',           'DELETE', '/admin/users/abc',                  true ],
  [null,              'GET',    '/admin/users',                      false],
  [null,              'GET',    '/admin/settlements',                false],
  ['sales_marketing', 'GET',    '/admin/session',                    true ],
];

for (const [role, method, path, want] of CASES) {
  test(`${role ?? 'no key'} ${method} ${path} -> ${want ? 'allow' : 'deny'}`, () => {
    assert.equal(can(role, method, path), want);
  });
}

test('marketing can never see settlements in its nav', () => {
  assert.ok(!SECTIONS.sales_marketing.includes('settlements'));
});

test('admin and accountant both get the settlements section', () => {
  for (const r of ['admin', 'accountant']) assert.ok(SECTIONS[r].includes('settlements'), r);
});

test('marketing keeps approvals and gains companies, nothing financial', () => {
  const m = SECTIONS.sales_marketing;
  assert.ok(m.includes('approvals'));
  assert.ok(m.includes('companies'));
  for (const forbidden of ['payments', 'quickbooks', 'deliveries', 'settlements']) {
    assert.ok(!m.includes(forbidden), `marketing must not have ${forbidden}`);
  }
});
