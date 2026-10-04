import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisualizationRequest, parseMakeoverRequest, parseItems, parseEnquiry, nextStep, jpegSize, nearestRatio, MAX_IMAGE_BYTES, MAX_PLANTS } from './rules.js';

// A minimal JPEG: the start marker, one frame header (SOF0) carrying the size, and the end marker.
const jpegOf = (width: number, height: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const jpeg = jpegOf(1200, 896).toString('base64');
const valid = { image: jpeg, spaceType: 'office', productId: 'snake-plant', style: 'japandi', placement: 'auto' };

test('accepts a valid request and resolves catalog entries', () => {
  const result = parseVisualizationRequest(valid);
  assert.ok(result.ok);
  assert.equal(result.value.mode, 'single');
  assert.equal(result.value.plant.id, 'snake-plant');
  assert.equal(result.value.style.id, 'japandi');
  assert.deepEqual(result.value.dims, {});
  assert.equal(result.value.aspect, '4:3');
});

test('rejects anything outside the catalog', () => {
  for (const key of ['spaceType', 'productId', 'style', 'placement']) {
    assert.equal(parseVisualizationRequest({ ...valid, [key]: 'nope' }).ok, false, key);
  }
  assert.equal(parseVisualizationRequest(undefined).ok, false);
});

test('accepts only JPEG images up to the size limit', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  assert.equal(parseVisualizationRequest({ ...valid, image: png }).ok, false);
  assert.equal(parseVisualizationRequest({ ...valid, image: '' }).ok, false);
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  assert.equal(parseVisualizationRequest({ ...valid, image: big.toString('base64') }).ok, false);
});

test('keeps sensible room sizes and rejects silly ones', () => {
  const result = parseVisualizationRequest({ ...valid, dims: { widthM: 6, ceilingM: 2.7 } });
  assert.ok(result.ok);
  assert.deepEqual(result.value.dims, { widthM: 6, ceilingM: 2.7 });
  assert.equal(parseVisualizationRequest({ ...valid, dims: { ceilingM: 300 } }).ok, false);
  assert.equal(parseVisualizationRequest({ ...valid, dims: { widthM: '6' } }).ok, false);
});

test("matches the output to the room photo's own shape, and rejects photos with no readable size", () => {
  assert.deepEqual(jpegSize(jpegOf(1200, 896)), { width: 1200, height: 896 });
  assert.equal(nearestRatio(1200, 896), '4:3'); // landscape stays landscape (G0 run 1: 'auto' returned a portrait)
  assert.equal(nearestRatio(896, 1200), '3:4');
  assert.equal(nearestRatio(1920, 1080), '16:9');
  assert.equal(nearestRatio(3000, 1000), '21:9');
  const portrait = parseVisualizationRequest({ ...valid, image: jpegOf(900, 1600).toString('base64') });
  assert.ok(portrait.ok);
  assert.equal(portrait.value.aspect, '9:16');
  // A JPEG signature with no frame header, or a zero-sized one, cannot be shown to the model.
  const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
  assert.equal(parseVisualizationRequest({ ...valid, image: noFrame }).ok, false);
  assert.equal(parseVisualizationRequest({ ...valid, image: jpegOf(0, 0).toString('base64') }).ok, false);
});

test('asks the provider at most every 5 s and gives up after 10 min', () => {
  const t = 1_000_000;
  assert.equal(nextStep({ status: 'succeeded', createdAt: t, checkedAt: t }, t), 'done');
  assert.equal(nextStep({ status: 'processing', createdAt: t, checkedAt: t }, t + 1_000), 'wait');
  assert.equal(nextStep({ status: 'processing', createdAt: t, checkedAt: t }, t + 5_000), 'check');
  assert.equal(nextStep({ status: 'processing', createdAt: t, checkedAt: t }, t + 10 * 60_000 + 1), 'timeout');
});

test('enquiries need a space, a name and a way to reach you', () => {
  const result = parseEnquiry({ space: 'cafe', name: '  Sam  ', contactMethod: 'Email', contact: 'sam@example.com', productId: 'monstera', visualizationId: 'a'.repeat(20) });
  assert.ok(result.ok);
  assert.equal(result.value.enquiry.name, 'Sam');
  assert.equal(result.value.enquiry.productId, 'monstera');
  assert.equal(result.value.enquiry.visualizationId, 'a'.repeat(20));
  assert.equal(result.value.photo, null);
  assert.equal(parseEnquiry({ space: 'cafe', name: '', contactMethod: 'Email', contact: 'x' }).ok, false);
  assert.equal(parseEnquiry({ space: 'cafe', name: 'Sam', contactMethod: 'Fax', contact: 'x' }).ok, false);
  assert.equal(parseEnquiry({ space: 'garage', name: 'Sam', contactMethod: 'Email', contact: 'x' }).ok, false);
});

test('enquiries drop unknown plants and malformed visualization ids, and reject bad photos', () => {
  const result = parseEnquiry({ space: 'cafe', name: 'Sam', contactMethod: 'Phone', contact: '0123 456', productId: 'plastic-tree', visualizationId: '../../etc' });
  assert.ok(result.ok);
  assert.equal(result.value.enquiry.productId, null);
  assert.equal(result.value.enquiry.visualizationId, null);
  assert.equal(parseEnquiry({ space: 'cafe', name: 'Sam', contactMethod: 'Phone', contact: '0123', photo: 'aGVsbG8=' }).ok, false);
});

const makeover = { image: jpeg, spaceType: 'cafe', style: 'japandi', items: [{ productId: 'snake-plant', quantity: 2 }, { productId: 'monstera', quantity: 1 }] };
const summary = (items: { plant: { id: string }; quantity: number }[]) => items.map((item) => [item.plant.id, item.quantity]);

test('a makeover request resolves its items in order and needs no plant or placement', () => {
  const result = parseMakeoverRequest(makeover);
  assert.ok(result.ok);
  assert.equal(result.value.mode, 'makeover');
  assert.deepEqual(summary(result.value.items), [['snake-plant', 2], ['monstera', 1]]);
  assert.equal(result.value.aspect, '4:3');
});

test('makeover items merge repeats, cap the total and reject anything unclear', () => {
  const merged = parseItems([{ productId: 'zz-plant', quantity: 1 }, { productId: 'zz-plant', quantity: 2 }]);
  assert.ok(merged.ok);
  assert.deepEqual(summary(merged.value), [['zz-plant', 3]]);
  assert.ok(parseItems([{ productId: 'zz-plant', quantity: MAX_PLANTS }]).ok);
  assert.equal(parseItems([{ productId: 'zz-plant', quantity: MAX_PLANTS }, { productId: 'monstera', quantity: 1 }]).ok, false); // 9 in total
  const unclear = [undefined, [], 'snake-plant', [null], [{ productId: 'plastic-tree', quantity: 1 }], [{ productId: 'zz-plant', quantity: 1.5 }], [{ productId: 'zz-plant', quantity: 0 }], [{ productId: 'zz-plant', quantity: '2' }], [{ productId: 'zz-plant' }]];
  for (const bad of unclear) assert.equal(parseItems(bad).ok, false, JSON.stringify(bad));
});

test('a makeover still needs a known space and style, a readable photo and items', () => {
  for (const key of ['spaceType', 'style']) assert.equal(parseMakeoverRequest({ ...makeover, [key]: 'nope' }).ok, false, key);
  assert.equal(parseMakeoverRequest({ ...makeover, image: '' }).ok, false);
  assert.equal(parseMakeoverRequest({ ...makeover, items: undefined }).ok, false);
  assert.equal(parseMakeoverRequest(undefined).ok, false);
});
