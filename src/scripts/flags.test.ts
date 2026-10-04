// Run with: node --test src/scripts/flags.test.ts   (builds the site five times, about 15 s)
// The preview and makeover are on trial: visible on Vercel Preview builds, hidden everywhere else (Production included)
// until PUBLIC_PREVIEW_ENABLED / PUBLIC_MAKEOVER_ENABLED is set to 1. This pins that, because a slip here shows the trial to customers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function buildWith(env: Record<string, string>): { preview: string; makeover: string } {
  mkdirSync('.astro', { recursive: true });
  const out = mkdtempSync(join('.astro', 'flags-'));
  try {
    // Start from a clean environment so a developer's own PUBLIC_* or VERCEL_ENV cannot change the answer.
    const { VERCEL_ENV, PUBLIC_PREVIEW_ENABLED, PUBLIC_MAKEOVER_ENABLED, ...rest } = process.env;
    void [VERCEL_ENV, PUBLIC_PREVIEW_ENABLED, PUBLIC_MAKEOVER_ENABLED];
    const run = spawnSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build', '--outDir', out], { env: { ...rest, ...env }, encoding: 'utf8' });
    assert.equal(run.status, 0, `astro build failed:\n${run.stdout}\n${run.stderr}`);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const read = (name: string) => html.match(new RegExp(`data-${name}-enabled="(\\d)"`))?.[1] ?? 'missing';
    return { preview: read('preview'), makeover: read('makeover') };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('Production hides the trial features', () => {
  assert.deepEqual(buildWith({ VERCEL_ENV: 'production' }), { preview: '0', makeover: '0' });
});

test('an unknown host (no VERCEL_ENV) hides them too, so a stray deploy cannot expose them', () => {
  assert.deepEqual(buildWith({}), { preview: '0', makeover: '0' });
});

test('Preview builds show them', () => {
  assert.deepEqual(buildWith({ VERCEL_ENV: 'preview' }), { preview: '1', makeover: '1' });
});

test('going live is deliberate: Production shows them only when the PUBLIC_ variables say 1', () => {
  assert.deepEqual(buildWith({ VERCEL_ENV: 'production', PUBLIC_PREVIEW_ENABLED: '1', PUBLIC_MAKEOVER_ENABLED: '1' }), { preview: '1', makeover: '1' });
  assert.deepEqual(buildWith({ VERCEL_ENV: 'production', PUBLIC_PREVIEW_ENABLED: '1' }), { preview: '1', makeover: '0' });
});

test('an explicit 0 wins over Preview', () => {
  assert.deepEqual(buildWith({ VERCEL_ENV: 'preview', PUBLIC_MAKEOVER_ENABLED: '0' }), { preview: '1', makeover: '0' });
});
