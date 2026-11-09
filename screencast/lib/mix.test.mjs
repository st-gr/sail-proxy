import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, buildTrack, trimSilence } from './mix.mjs';

test('plan starts each segment at its cue unless the previous one is still speaking, and the recap a second into the outro', () => {
  const p = plan([{ at: 5, seconds: 10 }, { at: 12, seconds: 4 }, { at: 30, seconds: 3 }], 6, 60, 50);
  assert.deepEqual(p.starts, [5, 15.35, 30]); assert.deepEqual(p.shifts, [0, 3.35, 0]);
  assert.equal(p.recapStart, 51); assert.equal(p.total, 60); assert.equal(p.freeze, 0);
  const long = plan([{ at: 5, seconds: 10 }], 20, 30, 20);
  assert.equal(long.recapStart, 21); assert.equal(long.total, 42.5); assert.equal(long.freeze, 12.5);
});

test('buildTrack places pcm at its start second and trimSilence cuts quiet ends back to a short margin', () => {
  const pcm = Buffer.alloc(4); pcm.writeInt16LE(1000, 0); pcm.writeInt16LE(1000, 2);
  const track = buildTrack([{ start: 1, pcm }], 10, 2);
  assert.equal(track.length, 40); assert.equal(track.readInt16LE(20), 1000);
  const quiet = Buffer.alloc(2 * 100); quiet.writeInt16LE(2000, 50 * 2);
  const t = trimSilence(quiet, 100);
  assert.ok(t.length < quiet.length && t.length >= 2);
});
