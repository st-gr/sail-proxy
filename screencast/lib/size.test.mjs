import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFor, sizedFile, sizeTag, cardViewport, bitrateFor } from './size.mjs';

test('encodeFor 1440p scales to 2560×1440 at the teaser bitrate', () => {
  const e = encodeFor('1440p');
  assert.ok(e.includes('scale=2560:1440:flags=lanczos,format=yuv420p'));
  assert.equal(e[e.indexOf('-b:v') + 1], '28M');
});

test('encodeFor 1080p is the encoding every clip and card has used so far', () => {
  const e = encodeFor('1080p');
  assert.ok(e.includes('scale=1920:1080:flags=lanczos,format=yuv420p'));
  assert.equal(e[e.indexOf('-b:v') + 1], '12M');
});

test('sizedFile maps cards and clips to their 1440p folders and leaves 1080p alone', () => {
  assert.equal(sizedFile('cards/intro.mp4', '1440p'), 'cards-1440p/intro.mp4');
  assert.equal(sizedFile('clips/section-3.mp4', '1440p'), 'clips-1440p/section-3.mp4');
  assert.equal(sizedFile('clips/section-3.mp4', '1080p'), 'clips/section-3.mp4');
});

test('sizeTag names the 1440p outputs like the teaser does', () => {
  assert.equal(sizeTag('1440p'), '_1440p');
  assert.equal(sizeTag('1080p'), '');
});

test('cardViewport draws the 1920×1080 card layout into 2560×1440 pixels', () => {
  assert.deepEqual(cardViewport('1440p'), { width: 2560, height: 1440, zoom: 4 / 3 });
  assert.deepEqual(cardViewport('1080p'), { width: 1920, height: 1080, zoom: 1 });
});

test('an unknown size is refused', () => {
  assert.throws(() => encodeFor('4k'), /unknown size 4k/);
});

test('bitrateFor gives the re-encodes after the concat the same bitrate as the pieces', () => {
  assert.equal(bitrateFor('1440p'), '28M');
  assert.equal(bitrateFor('1080p'), '12M');
});
