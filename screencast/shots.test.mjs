import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnly } from './shots.js';

test('--only needs an id', () => {
  assert.equal(parseOnly(['node', 'shots.js']), null);
  assert.equal(parseOnly(['node', 'shots.js', '--only', 'home']), 'home');
  assert.throws(() => parseOnly(['node', 'shots.js', '--only']), /^Error: usage: --only <id>$/);
  assert.throws(() => parseOnly(['node', 'shots.js', '--only', '--x']), /usage: --only <id>/);
});
