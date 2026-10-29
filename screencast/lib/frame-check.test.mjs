import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold, findLeaks, loadMaps, missingTools } from './frame-check.mjs';

// Invented values only.
const MAP = { 'FAKE-TOKEN-1007': 'demo-token', 'jdoe': 'demo', '_comment': 'not a value', 'ab': 'too-short' };

test('fold lower-cases, folds O/0 and l/I/1 and drops spaces', () => {
  assert.equal(fold('FAKE-T0KEN-l OO7'), fold('fake-token-1007'));
});

test('findLeaks: long values match through OCR confusions, short ones only as a whole word', () => {
  assert.deepEqual(findLeaks('key: fake-t0ken-l0O7 shown', MAP), ['demo-token']);
  assert.deepEqual(findLeaks('signed in as JDOE', MAP), ['demo']);
  assert.deepEqual(findLeaks('jdoesmith and abc and not a value', MAP), []);
});

test('loadMaps merges files and never quotes a malformed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-check-maps-'));
  writeFileSync(join(dir, 'a.json'), '{"x-real-1": "a"}');
  writeFileSync(join(dir, 'b.json'), '{"x-real-1": "b", "y-real-2": "c"}');
  writeFileSync(join(dir, 'bad.json'), '{"fake-secret-inside": ');
  assert.deepEqual(loadMaps([join(dir, 'a.json'), join(dir, 'b.json')]), { 'x-real-1': 'b', 'y-real-2': 'c' });
  assert.throws(() => loadMaps([join(dir, 'bad.json')]), (e) => /not valid JSON/.test(e.message) && !e.message.includes('fake-secret'));
});

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'frame-check.mjs');
const tools = [...missingTools(), ...(spawnSync('magick', ['-version']).error ? ['magick'] : [])];

test('the CLI reads a value off a generated video, names the mock and the time, and passes a clean video', { skip: tools.length ? `missing ${tools.join(', ')}` : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-check-video-'));
  const png = (name, text) => {
    const r = spawnSync('magick', ['-size', '640x120', 'xc:white', '-fill', 'black', '-pointsize', '36', '-annotate', '+20+75', text, join(dir, name)]);
    assert.equal(r.status, 0, String(r.stderr));
  };
  png('blank.png', 'Settings');
  png('leak.png', 'Key FAKE-T0KEN-1OO7');
  png('clean.png', 'Key demo-token');
  const video = (name, second) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-t', '1', '-i', join(dir, 'blank.png'), '-loop', '1', '-t', '1', '-i', join(dir, second),
      '-filter_complex', '[0][1]concat=n=2:v=1,format=yuv420p,fps=10', '-y', join(dir, name)]);
    assert.equal(r.status, 0, String(r.stderr));
    return join(dir, name);
  };
  writeFileSync(join(dir, 'map.json'), JSON.stringify(MAP));
  const run = (v) => spawnSync(process.execPath, [SCRIPT, v, '--every', '0.5', '--map', join(dir, 'map.json')], { encoding: 'utf8' });
  const leak = run(video('leak.mp4', 'leak.png'));
  assert.equal(leak.status, 1, leak.stdout + leak.stderr);
  assert.match(leak.stderr, /should show "demo-token" at 1s, 1\.5s/);
  assert.ok(!(leak.stdout + leak.stderr).includes('FAKE-TOKEN-1007'));
  const clean = run(video('clean.mp4', 'clean.png'));
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /frame check passed: 4 frames/);
});

test('the CLI exits 2 without a usable map', () => {
  const r = spawnSync(process.execPath, [SCRIPT, SCRIPT, '--map', join(tmpdir(), 'no-such-map.json')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
