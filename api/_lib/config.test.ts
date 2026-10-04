import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// .api-build/api/_lib/config.test.js -> ../../../ is the repo root
const root = new URL('../../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));

test('the create route has room for upload, Groq (8 s), signing and Kie, so it is not killed after a slot is taken', () => {
  const route = 'api/visualizations/index.ts';
  assert.ok(existsSync(new URL(route, root)), 'the route file Vercel will match must exist');
  assert.ok(config.functions?.[route]?.maxDuration >= 30, 'set functions["' + route + '"].maxDuration to at least 30 in vercel.json');
});
