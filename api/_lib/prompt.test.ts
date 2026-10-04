import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from './prompt.js';
import { catalog, byId } from './catalog.js';

const base = {
  space: byId(catalog.spaceTypes, 'office')!,
  plant: byId(catalog.plants, 'snake-plant')!,
  style: byId(catalog.styles, 'japandi')!,
  placement: byId(catalog.placements, 'corner')!,
  dims: {},
};

test('names the plant, its size, the placement and the style, and protects the room', () => {
  const prompt = buildPrompt(base);
  assert.match(prompt, new RegExp(`exactly one ${base.plant.name}`));
  assert.match(prompt, new RegExp(`about ${base.plant.heightCm} cm tall`));
  assert.match(prompt, /empty corner/);
  assert.match(prompt, /Design direction: Japandi/);
  assert.match(prompt, /do not add any other plants/);
  assert.doesNotMatch(prompt, /ceiling is about/);
});

test('turns ceiling height into a proportion the model can use', () => {
  const prompt = buildPrompt({ ...base, plant: { ...base.plant, heightCm: 81 }, dims: { ceilingM: 2.7 } });
  assert.match(prompt, /roughly 30% of the ceiling height/);
});

test('"Let AI decide" lists the plant\'s recommended spots, and "other" reads naturally', () => {
  const prompt = buildPrompt({ ...base, space: byId(catalog.spaceTypes, 'other')!, placement: byId(catalog.placements, 'auto')! });
  const firstSpot = byId(catalog.placements, base.plant.placements[0])!.label.toLowerCase();
  assert.match(prompt, /a photo of a real space\./);
  assert.match(prompt, new RegExp(`it suits being ${firstSpot}`));
});
