import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// A DOT courier created in the admin dashboard as "+263 0771 234 567" was
// saved with the local 0; the app signs in with +263771234567.
const rows = [{ id: 'c1', phone: '+2630771234567' }];
mock.module('../src/supabaseAdminClient.js', {
  namedExports: {
    supabaseAdmin: {
      from: () => {
        const q = {
          _eq: null,
          _in: null,
          select: () => q,
          eq: (_col, v) => ((q._eq = v), q),
          in: (_col, list) => ((q._in = list), q),
          limit: async () => ({ data: rows.filter((r) => q._in.includes(r.phone)), error: null }),
          single: async () => {
            const hit = rows.find((r) => r.phone === q._eq);
            return hit ? { data: hit, error: null } : { data: null, error: { code: 'PGRST116' } };
          },
        };
        return q;
      },
    },
  },
});

const { findProfileByPhone } = await import('../src/authService.js');

test('an account saved with the 0 after +263 is found from the app', async () => {
  assert.equal((await findProfileByPhone('+263771234567'))?.id, 'c1');
  assert.equal((await findProfileByPhone('0771234567'))?.id, 'c1');
  assert.equal((await findProfileByPhone('+263 077 123 4567'))?.id, 'c1');
});

test('a different number is still not found', async () => {
  assert.equal(await findProfileByPhone('+263771234568'), null);
});
