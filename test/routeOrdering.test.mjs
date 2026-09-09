/**
 * Express matches middleware and routes in registration order, so anything
 * registered after the catch-all 404 is unreachable — it answers "not a valid
 * endpoint" for a route that is right there in the file.
 *
 * This is invisible to a syntax check, to a build, and to any test that calls
 * the handler directly. It only shows up over HTTP, which is how it reached
 * the dashboard: the oversight, settlement and company routes were appended
 * at the end of server.js, 130 lines past the 404 handler.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

const CATCH_ALL = src.indexOf('// 404 handler');
const ERROR_HANDLER = src.indexOf('// Global error handler');

test('the 404 handler is present and findable', () => {
  assert.ok(CATCH_ALL > 0, 'expected a "// 404 handler" marker');
  assert.ok(ERROR_HANDLER > 0, 'expected a "// Global error handler" marker');
});

test('every route is registered before the error and 404 handlers', () => {
  const routeRe = /^app\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)/gm;
  const stranded = [];
  for (const m of src.matchAll(routeRe)) {
    if (m.index > Math.min(CATCH_ALL, ERROR_HANDLER)) stranded.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  assert.deepEqual(
    stranded,
    [],
    `these routes are registered after the catch-all and can never be reached:\n  ${stranded.join('\n  ')}`,
  );
});
