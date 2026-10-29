import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSong, musicFilter, textWindows, layerKey } from './assemble.mjs';

test('refuses a song of the wrong length', () => {
  assert.throws(() => checkSong(100), /105\.6 s/);
  assert.doesNotThrow(() => checkSong(105.625));
});

test('the short music keeps three stretches joined by 20 ms crossfades', () => {
  const f = musicFilter(1, 'short');
  // each inner join gets 10 ms on both sides, so the 20 ms crossfade is centred on it and nothing shifts
  for (const s of ['atrim=start=0:end=10.01', 'atrim=start=49.99:end=80.01', 'atrim=start=99.99:end=105.625']) assert.ok(f.includes(s), f);
  assert.equal(f.match(/acrossfade=d=0\.02/g).length, 2);
  assert.ok(f.endsWith('[a]'));
  assert.ok(!musicFilter(1, 'full').includes('atrim'));
});

test('a shot\'s text shows from its own song time to the shot\'s end, on the output timeline', () => {
  const t = [{ id: 'w', from: 60, to: 62.5, startFrame: 600, frames: 75, text: { lines: ['Quotas.'], style: 'punch', at: 61.25 } }, { id: 'n', from: 62.5, to: 65, startFrame: 675, frames: 75 }];
  assert.deepEqual(textWindows(t, 'short').map(({ id, start, end }) => ({ id, start, end })), [{ id: 'w', start: 638 / 30, end: 22.5 }]);
});

test('every text layer gets its own file name', () => {
  const a = layerKey({ kind: 'text', input: { lines: ['One gateway. Every tool.'], style: 'title' } });
  const b = layerKey({ kind: 'text', input: { lines: ['Open source. Community-built.'], style: 'title' } });
  assert.notEqual(a, b);
});
