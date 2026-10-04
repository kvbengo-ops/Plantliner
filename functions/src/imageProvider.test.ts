import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask } from './imageProvider.js';

test('maps Kie task states', () => {
  assert.deepEqual(parseTask({ state: 'waiting' }), { state: 'pending' });
  assert.deepEqual(parseTask({ state: 'generating' }), { state: 'pending' });
  assert.deepEqual(parseTask({ state: 'success', resultJson: '{"resultUrls":["https://tempfile.example/a.png"]}' }), { state: 'success', imageUrl: 'https://tempfile.example/a.png' });
  assert.deepEqual(parseTask({ state: 'fail', failMsg: 'content policy' }), { state: 'fail', message: 'content policy' });
});

test('success without an image is a failure, not an endless wait', () => {
  assert.equal(parseTask({ state: 'success', resultJson: '{}' }).state, 'fail');
  assert.equal(parseTask({ state: 'success', resultJson: 'not json' }).state, 'fail');
  assert.equal(parseTask({ state: 'success' }).state, 'fail');
});
