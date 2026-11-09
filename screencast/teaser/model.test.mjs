import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, timelineFor, CAPTION_BAR } from './model.mjs';
import { frameOf, END_HOLD, FPS } from './beats.mjs';

const env = { clipSeconds: (c) => (c === '05-cockpit/section-2' ? 20 : null), exists: (p) => p === 'docs/assets/x.png' };
const crop = { x: 0, y: 0, w: 1600, h: 900 };
const clip = (id, from, to, start = 0, more = {}) => ({ id, from, to, source: { clip: '05-cockpit/section-2', start, crop }, effect: 'cut', versions: ['full'], ...more });

test('rejects a source window beyond the clip', () => {
  const p = validate([clip('late', 0, 3, 18)], env);
  assert.ok(p.some((m) => m.includes('late') && m.includes('20.0 s')), p.join('\n'));
});

test('rejects a crop that shows the caption bar', () => {
  assert.equal(CAPTION_BAR.y, 930);
  const bare = { ...clip('bare', 0, 2), source: { clip: '05-cockpit/section-2', start: 0 } };
  const low = { ...clip('low', 0, 2), source: { clip: '05-cockpit/section-2', start: 0, crop: { x: 0, y: 200, w: 1280, h: 800 } } };
  const right = { ...clip('right', 0, 2), source: { clip: '05-cockpit/section-2', start: 0, crop: { x: 1260, y: 500, w: 600, h: 580 } } };
  const p = validate([bare, low, right], env);
  assert.ok(p.some((m) => m.includes('bare') && m.includes('caption')));
  assert.ok(p.some((m) => m.includes('low') && m.includes('caption')));
  assert.ok(!p.some((m) => m.includes('right') && m.includes('caption')));
});

test('a missing clip or image is a problem', () => {
  const p = validate([{ ...clip('nope', 0, 2), source: { clip: '09-x/section-1', start: 0, crop } }, { id: 'img', from: 2, to: 4, source: { image: 'docs/assets/y.png' }, effect: 'cut', versions: ['full'] }], env);
  assert.ok(p.some((m) => m.includes('nope'))); assert.ok(p.some((m) => m.includes('img')));
});

test('gaps and overlaps in a version are problems; unknown effects too', () => {
  const p = validate([clip('a', 0, 5), clip('b', 6, 10), clip('c', 9, 11, 0, { effect: 'spin' })], env);
  assert.ok(p.some((m) => m.includes('gap 5–6 s')), p.join('\n'));
  assert.ok(p.some((m) => m.includes('overlap')));
  assert.ok(p.some((m) => m.includes('spin')));
});

test('timelineFor maps a version\'s shots to frames and skips the others', () => {
  const shots = [clip('x', 50, 52.5, 0, { versions: ['full', 'short'] }), clip('y', 52.5, 55, 0)];
  const t = timelineFor(shots, 'short');
  assert.equal(t.length, 1);
  assert.equal(t[0].startFrame, 300); assert.equal(t[0].frames, 75);
});

test('a version covering its whole edit has the edit\'s frame count', () => {
  const card = (id, from, to, versions) => ({ id, from, to, source: { card: 'logo' }, effect: 'cut', versions });
  const shots = [card('a', 0, 10, ['full', 'short']), card('b', 10, 50, ['full']), card('c', 50, 80, ['full', 'short']), card('d', 80, 100, ['full']), card('e', 100, 105.625, ['full', 'short'])];
  assert.deepEqual(validate(shots, env), []);
  const sum = (v) => timelineFor(shots, v).reduce((n, s) => n + s.frames, 0);
  assert.equal(sum('full'), frameOf(105.625)); assert.equal(sum('short'), frameOf(45.625));
});

test('the end screen is held END_HOLD seconds past the music', () => {
  assert.equal(END_HOLD, 4);
  const shots = [{ id: 'a', from: 0, to: 100, source: { card: 'logo' }, effect: 'cut', versions: ['full'] }, { id: 'e', from: 100, to: 105.625, source: { card: 'end' }, effect: 'cut', versions: ['full'] }];
  const t = timelineFor(shots, 'full');
  assert.equal(t[1].frames, frameOf(105.625) - frameOf(100) + END_HOLD * FPS);
  assert.equal(t[0].frames, frameOf(100));
});
