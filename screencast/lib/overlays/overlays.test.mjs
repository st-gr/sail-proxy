import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HALO } from './halo.mjs';
import { TOOLTIP } from './tooltip.mjs';
import { CAPTION } from './caption.mjs';
import { BLUR } from './blur.mjs';

test('every overlay parses as a script and is idempotent by a marker', () => {
  for (const [name, src] of [['halo', HALO], ['tooltip', TOOLTIP], ['caption', CAPTION]]) {
    assert.doesNotThrow(() => new Function(src), `${name} does not parse`);
    assert.ok(/if \((document\.querySelector\('style\[data-sail-\w+\]'\)|window\.__sailCaption)\) return;/.test(src), `${name} has no idempotence guard`);
  }
  assert.ok(CAPTION.includes('window.__sailCaption = '));
});

test('the tooltip bubble skips a title that only repeats the visible text', () => {
  assert.ok(TOOLTIP.includes("holder.textContent.trim() === text.trim()"));
});

test('the blur overlay hides avatars on GitHub pages only', () => {
  assert.ok(BLUR.includes("location.hostname.endsWith('github.com')"));
  for (const sel of ['img.avatar', '.avatar-user', 'img[src*="avatars.githubusercontent.com"]']) assert.ok(BLUR.includes(sel), sel);
  assert.ok(/filter: blur\(\d+px\)/.test(BLUR));
});


test('a shown caption keeps an invisible pixel repainting, so an idle page still writes the caption\'s frame', () => {
  assert.ok(CAPTION.includes('setInterval'));
  assert.ok(CAPTION.includes('sail-cap-paint'));
});
