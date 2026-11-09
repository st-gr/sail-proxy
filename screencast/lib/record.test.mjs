import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLoad, startCastServer, ENCODE, needsStill, pageMisses } from './record.mjs';
import { H264 } from './encoder.mjs';

test('atLoad defers to DOMContentLoaded when the body is not there yet', () => {
  assert.ok(atLoad('x()').includes("document.addEventListener('DOMContentLoaded', run)"));
  assert.ok(atLoad('x()').includes('if (document.body) run()'));
});

test('the cast server serves the page and the player, and refuses paths outside its folders', async () => {
  const server = await startCastServer('03-docker-compose', 0);
  const port = server.address().port;
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return r.status; };
  assert.equal(await get('/cast.html'), 200);
  assert.equal(await get('/player/asciinema-player.min.js'), 200);
  assert.equal(await get('/casts/03-docker-compose/../../check.js'), 404);
  assert.equal(await get('/etc/passwd'), 404);
  assert.equal(await get('/cards/cards.html'), 200);
  assert.equal(await get('/fonts/72-Regular.woff2'), 200);
  assert.equal(await get('/assets/sail-proxy-logo.svg'), 200);
  server.close();
});

test('clips are encoded to 1080p30 H.264 without audio', () => {
  assert.ok(ENCODE.includes(H264) && ENCODE.includes('-an') && ENCODE.join(' ').includes('scale=1920:1080'));
});

test('a clip under 1 KB (or unreadable) is replaced by a still', () => {
  assert.equal(needsStill(0), true); assert.equal(needsStill(1023), true); assert.equal(needsStill(1024), false);
  assert.equal(needsStill(5000, false), true); assert.equal(needsStill(5000, true), false);
});

test('a port already in use rejects with a clear message', async () => {
  const first = await startCastServer('v', 0);
  await assert.rejects(startCastServer('v', first.address().port), /already in use/);
  first.close();
});

test('a page read that fails once is retried; one that fails twice is a miss, never a clean page', async () => {
  let calls = 0; let first = 0; let second = 0;
  assert.deepEqual(await pageMisses(async () => { if (++calls === 1) { first = Date.now(); throw new Error('detached'); } second = Date.now(); return 'fine'; }, {}, 50), []);
  assert.equal(calls, 2);
  assert.ok(second - first >= 45, 'the retry waits before reading again');
  assert.deepEqual(await pageMisses(async () => { throw new Error('gone'); }, {}), ['page text unreadable']);
  assert.deepEqual(await pageMisses(async () => 'a key sk-' + 'live' + '0123456789abcdefghijklmn', {}), ['api key']);
});
