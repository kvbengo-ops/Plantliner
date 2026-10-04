// Run with: node --test src/scripts/makeover.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_PLANTS, capQuantity, fromItems, summarise, toItems, total } from './makeover.ts';

test('the picker and API use the same plant cap', () => {
  const rules = readFileSync(new URL('../../api/_lib/rules.ts', import.meta.url), 'utf8');
  assert.equal(Number(rules.match(/export const MAX_PLANTS = (\d+)/)?.[1]), MAX_PLANTS);
});

test('a quantity cannot exceed the remaining total', () => {
  assert.equal(capQuantity(3, 0), 3);
  assert.equal(capQuantity(5, 4), 4);
  assert.equal(capQuantity(1, MAX_PLANTS), 0);
  assert.equal(capQuantity(99, 0), MAX_PLANTS);
});

test('unusable quantities become zero and fractions round down', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) assert.equal(capQuantity(bad, 0), 0, String(bad));
  assert.equal(capQuantity(2.9, 0), 2);
});

test('only chosen plants are sent, in catalog order', () => {
  assert.deepEqual(toItems({ monstera: 1, 'snake-plant': 0, 'zz-plant': 2 }), [
    { productId: 'monstera', quantity: 1 },
    { productId: 'zz-plant', quantity: 2 },
  ]);
  assert.deepEqual(toItems({}), []);
  assert.equal(total({ a: 2, b: 3 }), 5);
});

test('saved items restore the picker and invalid items are refused', () => {
  assert.deepEqual(fromItems([{ productId: 'monstera', quantity: 2 }, { productId: 'monstera', quantity: 1 }]), { monstera: 3 });
  const odd = [undefined, [], 'monstera', [null], [{ productId: 'monstera' }],
    [{ productId: 'monstera', quantity: 0 }], [{ productId: 'monstera', quantity: 1.5 }],
    [{ productId: 'monstera', quantity: MAX_PLANTS + 1 }], [{ productId: 7, quantity: 1 }]];
  for (const bad of odd) assert.equal(fromItems(bad), null, JSON.stringify(bad));
});

test('the summary reads naturally', () => {
  assert.equal(summarise([{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }], (id) => id.toUpperCase()), '2 × A, 1 × B');
});
