import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, toOutput, frameOf, span, EDITS, SONG_SECONDS } from './beats.mjs';

test('at() counts bars and beats from 0 on the 96 BPM grid', () => {
  assert.equal(at(8), 20);
  assert.equal(at(24, 2), 61.25);
});

test('toOutput maps song time through the short version\'s cuts', () => {
  assert.equal(toOutput(55, 'short'), 15);
  assert.equal(toOutput(101, 'short'), 41);
  assert.equal(toOutput(30, 'full'), 30);
  assert.throws(() => toOutput(30, 'short'), /song time 30 is cut from the short version/);
});

test('span gives the first frame and frame count on the output timeline', () => {
  assert.deepEqual(span(50, 52.5, 'short'), { startFrame: 300, frames: 75 });
});

test('a shot across a cut is rejected', () => {
  assert.throws(() => span(8, 12, 'short'), /a shot across a cut/);
});

test('frame positions do not drift over 168 beats', () => {
  let next = 0;
  for (let b = 0; b < 168; b++) {
    const s = span(b * 0.625, (b + 1) * 0.625, 'full');
    assert.equal(s.startFrame, next); next = s.startFrame + s.frames;
  }
  assert.equal(next, frameOf(105));
});

test('the short edit is 45.625 s and the full one the whole song', () => {
  assert.equal(EDITS.short.reduce((n, e) => n + e.to - e.from, 0), 45.625);
  assert.equal(EDITS.full[0].to, SONG_SECONDS);
});
