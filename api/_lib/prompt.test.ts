import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildMakeoverPrompt } from './prompt.js';
import { parseItems } from './rules.js';
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

const itemsOf = (list: [string, number][]) => {
  const result = parseItems(list.map(([productId, quantity]) => ({ productId, quantity })));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const makeoverBase = { space: byId(catalog.spaceTypes, 'cafe')!, style: byId(catalog.styles, 'japandi')!, dims: {} };

test('makeover prompt numbers the reference photos, names every plant with count and size, and protects the room', () => {
  const items = itemsOf([['snake-plant', 2], ['monstera', 1]]);
  const plan = {
    rationale: 'Balanced.',
    furniture: ['Turn the two armchairs to face the window'],
    plants: [
      { productId: 'snake-plant', count: 2, placement: 'corner', why: 'x' },
      { productId: 'monstera', count: 1, placement: 'window', why: 'y' },
    ],
  };
  const prompt = buildMakeoverPrompt({ ...makeoverBase, items, plan, dims: { ceilingM: 2.7 } });
  assert.match(prompt, /photo of a real café/);
  assert.match(prompt, /image 2 is the Snake Plant; image 3 is the Monstera/);
  assert.match(prompt, /- 2 x Snake Plant, about 80 cm tall including its pot, pot about 25 cm wide: standing on the floor in an empty corner\./);
  assert.match(prompt, /- 1 x Monstera, .*: near a window\./);
  assert.match(prompt, /- Turn the two armchairs to face the window/);
  assert.match(prompt, /Do not add, remove, duplicate or restyle any furniture/);
  assert.match(prompt, /architecture exactly as it is/);
  assert.match(prompt, /Design direction: Japandi/);
  assert.match(prompt, /ceiling is about 2\.7 m high/);
  assert.doesNotMatch(prompt, /Balanced|\bx\b\.|\by\b\./); // the rationale and per-plant notes are for the customer, not the image model
});

test('makeover prompt says nothing moves when the designer moved nothing', () => {
  const items = itemsOf([['zz-plant', 1]]);
  const plan = { rationale: 'Fine.', furniture: [], plants: [{ productId: 'zz-plant', count: 1, placement: 'entrance', why: 'z' }] };
  const prompt = buildMakeoverPrompt({ ...makeoverBase, items, plan });
  assert.match(prompt, /Do not move, add, remove or restyle any furniture/);
  assert.doesNotMatch(prompt, /You may rearrange/);
});

test("makeover prompt stays under Kie's 5000 characters at the largest request", () => {
  const items = itemsOf([['snake-plant', 2], ['zz-plant', 2], ['monstera', 2], ['fiddle-leaf-fig', 1], ['barrel-cactus', 1]]);
  const spots = ['floor', 'corner', 'window', 'cabinet', 'entrance'];
  const plan = {
    rationale: 'a'.repeat(600),
    furniture: Array(6).fill('b'.repeat(120)),
    plants: items.map(({ plant, quantity }, i) => ({ productId: plant.id, count: quantity, placement: spots[i], why: 'c'.repeat(120) })),
  };
  const prompt = buildMakeoverPrompt({ ...makeoverBase, items, plan, dims: { widthM: 200, lengthM: 200, ceilingM: 20 } });
  assert.ok(prompt.length < 5000, `prompt is ${prompt.length} characters`);
});
