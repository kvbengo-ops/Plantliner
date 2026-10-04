import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseReply, designerRequest, design, DESIGNER_MODEL } from './designer.js';
import { parseItems } from './rules.js';
import { catalog, byId } from './catalog.js';

const parsed = parseItems([{ productId: 'snake-plant', quantity: 2 }, { productId: 'monstera', quantity: 1 }]);
if (!parsed.ok) throw new Error(parsed.error);
const items = parsed.value;
const good = {
  rationale: 'Seating is grouped near the window so the room feels open, and the tall plants frame the entrance.',
  furniture: ['Turn the two armchairs to face the window'],
  plants: [
    { productId: 'snake-plant', count: 2, placement: 'corner', why: 'Upright leaves soften the corner' },
    { productId: 'monstera', count: 1, placement: 'window', why: 'Bright light suits its big leaves' },
  ],
};
const input = { space: byId(catalog.spaceTypes, 'cafe')!, style: byId(catalog.styles, 'japandi')!, items, dims: { widthM: 6, lengthM: 4 }, roomUrl: 'https://signed.example/room.jpg' };

test('accepts a good plan, tidies whitespace and control characters', () => {
  const result = parsePlan({ ...good, rationale: '  Calm   and\nbalanced.  ' }, items);
  assert.ok(result.ok);
  assert.equal(result.value.rationale, 'Calm and balanced.');
  assert.deepEqual(result.value.plants, good.plants);
  assert.ok(parsePlan({ ...good, furniture: [] }, items).ok); // nothing needs to move
  // Invisible and direction-changing characters are dropped, so they cannot hide or reorder text.
  const hidden = parsePlan({ ...good, rationale: 'Calm\u200B and \u202Ebalanced.\u0085Open.' }, items);
  assert.ok(hidden.ok);
  assert.equal(hidden.value.rationale, 'Calm and balanced. Open.');
  // Ordinary design wording is not mistaken for a link.
  assert.ok(parsePlan({ ...good, furniture: ['Move the long table against the left wall.', 'Turn the sofas toward the window, e.g. at an angle.'] }, items).ok);
});

test('rejects anything that is not exactly what was asked for', () => {
  const plant = good.plants[0];
  const rejected: Record<string, unknown> = {
    'not an object': 'plan',
    'extra top-level key': { ...good, bonus: 1 },
    'extra plant key': { ...good, plants: [{ ...plant, bonus: 1 }, good.plants[1]] },
    'empty rationale': { ...good, rationale: '   ' },
    'rationale over 600': { ...good, rationale: 'a'.repeat(601) },
    'note over 120': { ...good, furniture: ['a'.repeat(121)] },
    'seven moves': { ...good, furniture: Array(7).fill('Move the table') },
    'furniture not a list': { ...good, furniture: 'Move the table' },
    'link in rationale': { ...good, rationale: 'See https://example.com for more' },
    'www link in a note': { ...good, furniture: ['Visit www.example.com'] },
    'html in a note': { ...good, furniture: ['<b>Move</b> the table'] },
    'product that was not requested': { ...good, plants: [{ ...plant, productId: 'zz-plant' }, good.plants[1]] },
    'placement auto': { ...good, plants: [{ ...plant, placement: 'auto' }, good.plants[1]] },
    'unknown placement': { ...good, plants: [{ ...plant, placement: 'ceiling' }, good.plants[1]] },
    'counts too low': { ...good, plants: [{ ...plant, count: 1 }, good.plants[1]] },
    'counts too high': { ...good, plants: [{ ...plant, count: 3 }, good.plants[1]] },
    'requested product missing': { ...good, plants: [plant] },
    'fractional count': { ...good, plants: [{ ...plant, count: 1.5 }, good.plants[1]] },
    'missing why': { ...good, plants: [{ ...plant, why: '' }, good.plants[1]] },
    'the word http on its own': { ...good, rationale: 'See http for details' },
    'scheme split by a space': { ...good, rationale: 'Visit https //evil.example today' },
    'scheme split by zero-width space': { ...good, rationale: 'Visit ht\u200Btp://evil.example today' },
    'bare domain in a note': { ...good, furniture: ['Offers at bit.ly/abc'] },
    'bare domain with a path in a why': { ...good, plants: [{ ...plant, why: 'Details at evil.com/pay' }, good.plants[1]] },
    'markdown link': { ...good, rationale: 'Click [here](evil) for the plan' },
  };
  for (const [name, plan] of Object.entries(rejected)) assert.equal(parsePlan(plan, items).ok, false, name);
});

test('counts may be split across several placements as long as they add up', () => {
  const split = { ...good, plants: [{ ...good.plants[0], count: 1 }, { ...good.plants[0], count: 1, placement: 'entrance' }, good.plants[1]] };
  assert.ok(parsePlan(split, items).ok);
});

test('reads the plan out of a Groq reply and rejects anything else', () => {
  const reply = (content: unknown) => ({ choices: [{ message: { content } }] });
  assert.ok(parseReply(reply(JSON.stringify(good)), items).ok);
  for (const bad of [reply('not json'), reply(undefined), reply(null), {}, null, reply('{"rationale":"x"}')]) assert.equal(parseReply(bad, items).ok, false);
});

test('the request is catalog data plus fixed text, with the room as an image', () => {
  const body = designerRequest(input);
  assert.equal(body.model, DESIGNER_MODEL);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const [text, image] = body.messages[0].content as unknown as [{ text: string }, { image_url: { url: string } }];
  assert.equal(image.image_url.url, input.roomUrl);
  assert.match(text.text, /JSON/); // Groq's JSON mode requires the word
  assert.match(text.text, /2 x Snake Plant \(productId "snake-plant"\)/);
  assert.match(text.text, /1 x Monstera/);
  assert.match(text.text, /Space: Café/);
  assert.match(text.text, /roughly 6 m by 4 m/);
  assert.match(text.text, /floor, corner, window, desk, cabinet, entrance/); // never "auto"
  assert.doesNotMatch(text.text, /armchair|sofa|couch/i); // a concrete example gets copied even when the photo has none
  assert.match(text.text, /that you can actually see/);
  // The first real run (office, Japandi) came back with "keep the desks centered" notes and nothing moved.
  assert.match(text.text, /between 2 and 6 notes/);
  assert.match(text.text, /start with a verb such as Move, Turn, Rotate/);
  assert.match(text.text, /Never write a note that keeps something where it is/);
  assert.match(text.text, /professional space planner/);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.GROQ_API_KEY = 'test-key';
});
function stubFetch(json: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return calls;
}

test('design() calls Groq with the key and returns the checked plan', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const calls = stubFetch({ choices: [{ message: { content: JSON.stringify(good) } }] });
  const plan = await design(input);
  assert.deepEqual(plan.plants, good.plants);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key');
});

test('design() fails on a Groq error, an invalid plan or a missing key, and never echoes the key', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  stubFetch({ error: { message: 'rate limited' } }, 429);
  await assert.rejects(design(input), (err: Error) => /HTTP 429 rate limited/.test(err.message) && !err.message.includes('test-key'));
  stubFetch({ choices: [{ message: { content: JSON.stringify({ ...good, plants: [] }) } }] });
  await assert.rejects(design(input), /Designer plan rejected: counts/);
  delete process.env.GROQ_API_KEY;
  await assert.rejects(design(input), /GROQ_API_KEY is not set/);
});
