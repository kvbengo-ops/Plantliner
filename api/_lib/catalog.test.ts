import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { catalog } from './catalog.js';

test('catalog ids are unique and every option the prompt uses has wording', () => {
  for (const list of [catalog.spaceTypes, catalog.styles, catalog.placements, catalog.plants]) {
    const ids = list.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in: ${ids.join(', ')}`);
  }
  for (const option of [...catalog.styles, ...catalog.placements]) assert.ok(option.prompt, `${option.id} needs a prompt`);
});

test('every plant has real dimensions, known placements and a photo', () => {
  const placementIds = catalog.placements.map((placement) => placement.id);
  for (const plant of catalog.plants) {
    assert.ok(plant.heightCm > 0 && plant.potDiameterCm > 0, `${plant.id} needs real dimensions`);
    for (const placement of plant.placements) assert.ok(placementIds.includes(placement) && placement !== 'auto', `${plant.id}: unknown placement ${placement}`);
    // .api-build/api/_lib/catalog.test.js → ../../../ is the repo root
    assert.ok(existsSync(new URL(`../../../public${plant.image}`, import.meta.url)), `${plant.id}: missing public${plant.image}`);
  }
});
