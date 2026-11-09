#!/usr/bin/env node
// updateHint: once-a-day "newer version" line, silent on every failure. No network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateHint, hintWithGrace } = require('../dist/utils/updateHint');
const { compareVersions } = require('../dist/utils/version');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hint-'));
const reply = (version, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ version }) });
const counting = (impl) => { const f = async (...a) => { f.calls++; return impl(...a); }; f.calls = 0; return f; };
const NOW = Date.parse('2026-11-07T10:00:00Z');

(async () => {
  delete process.env.SAIL_PROXY_UPDATE_CHECK;

  // version semantics
  assert.ok(compareVersions('0.12.0', '0.11.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0, 'numeric pre-release identifiers compare numerically');
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);

  // newer -> hint
  let dir = mk();
  const hint = await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: reply('0.12.0') });
  assert.ok(hint && hint.includes('0.12.0') && hint.includes('0.11.0'), String(hint));

  // same / older -> null
  dir = mk();
  assert.strictEqual(await updateHint({ current: '0.12.0', now: NOW, configDir: dir, fetch: reply('0.12.0') }), null);
  dir = mk();
  assert.strictEqual(await updateHint({ current: '0.13.0', now: NOW, configDir: dir, fetch: reply('0.12.0') }), null);

  // cached within 24 h, refetched after
  dir = mk();
  const f1 = counting(reply('0.12.0'));
  await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: f1 });
  const cached = await updateHint({ current: '0.11.0', now: NOW + 23 * 3600e3, configDir: dir, fetch: f1 });
  assert.strictEqual(f1.calls, 1);
  assert.ok(cached && cached.includes('0.12.0'));
  assert.ok(fs.existsSync(path.join(dir, 'update-check.json')));
  await updateHint({ current: '0.11.0', now: NOW + 25 * 3600e3, configDir: dir, fetch: f1 });
  assert.strictEqual(f1.calls, 2);

  // offline / 404 / garbage -> null, no throw, nothing cached
  dir = mk();
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: async () => { throw new Error('offline'); } }), null);
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: reply('x', 404) }), null);
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), null);
  // failures are cached for 6 h: no refetch inside, refetch after
  const off = counting(async () => { throw new Error('offline'); });
  dir = mk();
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: off }), null);
  assert.ok(fs.existsSync(path.join(dir, 'update-check.json')));
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW + 5 * 3600e3, configDir: dir, fetch: off }), null);
  assert.strictEqual(off.calls, 1);
  await updateHint({ current: '0.11.0', now: NOW + 7 * 3600e3, configDir: dir, fetch: off });
  assert.strictEqual(off.calls, 2);

  // the run path does not wait for a hanging registry
  const t0 = Date.now();
  const slow = await hintWithGrace(updateHint({ current: '0.11.0', now: NOW, configDir: mk(), fetch: () => new Promise(() => {}) }), 100);
  assert.strictEqual(slow, null);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(await hintWithGrace(Promise.resolve('x'), 100));

  // unwritable config dir / corrupt cache stay silent
  dir = mk();
  fs.writeFileSync(path.join(dir, 'update-check.json'), '{not json');
  assert.ok(await updateHint({ current: '0.11.0', now: NOW, configDir: dir, fetch: reply('0.12.0') }));
  assert.ok(await updateHint({ current: '0.11.0', now: NOW, configDir: path.join(dir, 'update-check.json', 'x'), fetch: reply('0.12.0') }));

  // disabled
  process.env.SAIL_PROXY_UPDATE_CHECK = 'false';
  const f2 = counting(reply('9.9.9'));
  assert.strictEqual(await updateHint({ current: '0.11.0', now: NOW, configDir: mk(), fetch: f2 }), null);
  assert.strictEqual(f2.calls, 0);

  console.log('update-hint: ok');
})().catch((e) => { console.error(e); process.exit(1); });
