import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { shotArgs, effectFilter } from './render.mjs';
import { EFFECTS } from './model.mjs';

const clipShot = { id: 'k', source: { clip: '05-cockpit/section-2', start: 4, crop: { x: 100, y: 50, w: 1600, h: 900 } }, effect: 'push-in', frames: 75 };

test('a clip shot seeks, crops before it scales, and renders exactly its frames without audio', () => {
  const a = shotArgs(clipShot, { inputPath: '/c.mp4' }); const s = a.join(' ');
  assert.ok(s.includes('-ss 4 '));
  assert.ok(a.includes('-frames:v') && a[a.indexOf('-frames:v') + 1] === '75');
  assert.ok(a.includes('-r') && a[a.indexOf('-r') + 1] === '30');
  assert.ok(a.includes('-an'));
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.indexOf('crop=1600:900:100:50') < fc.indexOf('scale=1920:1080'), fc);
});

test('an image or a card is looped as a still', () => {
  const img = shotArgs({ id: 'i', source: { image: 'docs/assets/x.png' }, effect: 'cut', frames: 30 }, { inputPath: '/x.png' });
  assert.ok(img.join(' ').includes('-loop 1'));
  const card = shotArgs({ id: 'c', source: { card: 'logo' }, effect: 'flash', frames: 30 }, { inputPath: '/logo.png' });
  assert.ok(card.join(' ').includes('-loop 1 -i /logo.png'));
});

test('every effect has a filter and an unknown one throws', () => {
  for (const e of EFFECTS) assert.equal(typeof effectFilter(e, 75), 'string');
  assert.throws(() => effectFilter('spin', 75), /unknown effect spin/);
});

// A zoom must glide: rendered over a white square on navy, the square's brightness-weighted centre stays put (to a
// tenth of a pixel) and it only grows (push-in) or shrinks (pull-out). zoompan placed its window on whole pixels and
// rounded size and position apart, so the opening logo shook by half a pixel from frame to frame.
const FRAMES = 45;
function measure(effect, line) {
  const pick = line === 'row' ? 'crop=1920:1:0:540' : 'crop=1:1080:960:0,transpose=1';
  const fc = `color=c=0x0B1F33:s=1920x1080:r=30:d=2,drawbox=x=760:y=340:w=400:h=400:color=white:t=fill,format=yuv420p[v];${effectFilter(effect, FRAMES)};[o]${pick},format=gray[p]`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-filter_complex', fc, '-map', '[p]', '-frames:v', String(FRAMES), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  const len = line === 'row' ? 1920 : 1080; const out = [];
  for (let f = 0; f < FRAMES; f++) {
    const px = r.stdout.subarray(f * len, (f + 1) * len); let mass = 0; let moment = 0;
    for (let i = 0; i < len; i++) { const v = Math.max(0, px[i] - 40); mass += v; moment += v * i; }
    out.push({ centre: moment / mass, size: mass / 215 });
  }
  return out;
}
for (const effect of ['push-in', 'pull-out']) {
  test(`${effect} keeps the picture centred and changes its size steadily`, () => {
    for (const line of ['row', 'column']) {
      const m = measure(effect, line); const mid = line === 'row' ? 959.5 : 539.5;
      for (const [i, { centre }] of m.entries()) assert.ok(Math.abs(centre - mid) <= 0.1, `${line} frame ${i}: centre ${centre.toFixed(3)}`);
      for (let i = 1; i < m.length; i++) {
        const step = m[i].size - m[i - 1].size;
        assert.ok(effect === 'push-in' ? step >= 0 : step <= 0, `${line} frame ${i}: size ${m[i - 1].size.toFixed(1)} → ${m[i].size.toFixed(1)}`);
      }
    }
  });
}

// A still is looped, so frames keep coming past the shot's end: the zoom stays within 1 to 1.12 there, or the
// pull-out asks crop for more picture than the frame has and ffmpeg crashes (the logo's "Forever." shot did).
test('a pull-out on a looped still renders to its end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teaser-zoom-')); const png = join(dir, 'still.png'); const out = join(dir, 'shot.mp4');
  try {
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1920x1080', '-frames:v', '1', png]).status, 0);
    const r = spawnSync('ffmpeg', shotArgs({ id: 'p', source: { card: 'logo' }, effect: 'pull-out', frames: 112 }, { inputPath: png, outFile: out }), { encoding: 'utf8' });
    assert.equal(r.signal, null, 'ffmpeg crashed');
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
