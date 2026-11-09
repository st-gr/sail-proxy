import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadState } from './state.mjs';

test('a malformed state file throws a fixed message that does not quote the input', () => {
  const input = '{"priceModelId": "x", "key": sk-secret-value-xyz}';
  assert.throws(() => loadState(input), (err) => err.message === 'seed-keys.json is not valid JSON' && !err.message.includes('secret'));
  assert.deepEqual(loadState('{"priceModelId":"m"}'), { priceModelId: 'm' });
});
