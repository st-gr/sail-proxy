#!/usr/bin/env node
// migrateConfigDir: all-or-nothing file migrations of the config folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateConfigDir, CONFIG_FORMAT, MIGRATIONS, ConfigMigrationError } = require('../dist/migrations');

const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mig-'));
  fs.writeFileSync(path.join(d, '.env'), 'PORT=3000\n');
  fs.writeFileSync(path.join(d, 'apikeys.json'), '[{"name":"a","key":"k"}]');
  fs.mkdirSync(path.join(d, 'logs'));
  fs.writeFileSync(path.join(d, 'logs', 'gateway.log'), 'log');
  fs.mkdirSync(path.join(d, 'backups'));
  fs.writeFileSync(path.join(d, 'backups', 'x.spbk'), 'bundle');
  return d;
};
const snapshot = (d) => {
  const out = {};
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) walk(f); else out[path.relative(d, f)] = fs.readFileSync(f, 'utf-8');
  } };
  walk(d); return out;
};
const version = (d) => fs.readFileSync(path.join(d, 'format-version'), 'utf-8').trim();

(async () => {
  assert.strictEqual(CONFIG_FORMAT, 1);
  assert.deepStrictEqual(MIGRATIONS, []);

  // no migrations: no-op, writes format-version 1, no backup
  let d = mk();
  let r = await migrateConfigDir(d);
  assert.deepStrictEqual(r, { from: 1, to: 1 });
  assert.strictEqual(version(d), '1');
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'backups')), ['x.spbk']);
  r = await migrateConfigDir(d); // idempotent
  assert.strictEqual(r.to, 1);

  // two migrations run in order, backup exists, version 3
  d = mk();
  const order = [];
  const ms = [
    { from: 1, to: 2, run: async (dir) => { order.push(1); fs.writeFileSync(path.join(dir, 'apikeys.json'), '[]'); } },
    { from: 2, to: 3, run: async (dir) => { order.push(2); fs.writeFileSync(path.join(dir, 'new.json'), '{}'); } },
  ];
  r = await migrateConfigDir(d, ms);
  assert.deepStrictEqual(order, [1, 2]);
  assert.strictEqual(r.from, 1); assert.strictEqual(r.to, 3);
  assert.strictEqual(version(d), '3');
  assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'apikeys.json')));
  assert.strictEqual(fs.readFileSync(path.join(r.backup, 'apikeys.json'), 'utf-8'), '[{"name":"a","key":"k"}]');
  assert.ok(path.dirname(r.backup) === path.join(d, 'backups') && /^format-1-[A-Za-z0-9._-]+$/.test(path.basename(r.backup)));
  assert.ok(!fs.existsSync(path.join(r.backup, 'logs')) && !fs.existsSync(path.join(r.backup, 'backups')));
  r = await migrateConfigDir(d, ms); // already at 3: nothing runs
  assert.deepStrictEqual(order, [1, 2]);
  assert.strictEqual(r.from, 3);

  // a failing migration restores every file byte-identically
  d = mk();
  const before = snapshot(d);
  const bad = [
    { from: 1, to: 2, run: async (dir) => { fs.writeFileSync(path.join(dir, 'apikeys.json'), 'CORRUPT'); fs.writeFileSync(path.join(dir, 'extra.json'), '1'); fs.rmSync(path.join(dir, '.env')); } },
    { from: 2, to: 3, run: async () => { throw new Error('boom'); } },
  ];
  await assert.rejects(() => migrateConfigDir(d, bad), (e) => e instanceof ConfigMigrationError && /boom/.test(e.message));
  const after = snapshot(d);
  for (const k of Object.keys(before)) assert.strictEqual(after[k], before[k], k);
  assert.ok(!('extra.json' in after) && !('format-version' in after));

  // failure after editing, with an existing format-version, keeps that version
  d = mk(); fs.writeFileSync(path.join(d, 'format-version'), '2\n');
  await assert.rejects(() => migrateConfigDir(d, [{ from: 2, to: 3, run: async (dir) => { fs.writeFileSync(path.join(dir, 'apikeys.json'), 'X'); throw new Error('x'); } }]), ConfigMigrationError);
  assert.strictEqual(version(d), '2');
  assert.strictEqual(fs.readFileSync(path.join(d, 'apikeys.json'), 'utf-8'), '[{"name":"a","key":"k"}]');

  // newer config: refuse
  d = mk(); fs.writeFileSync(path.join(d, 'format-version'), '9\n');
  await assert.rejects(() => migrateConfigDir(d), (e) => e instanceof ConfigMigrationError && /this config was written by a newer sail-proxy/.test(e.message));
  assert.strictEqual(version(d), '9');

  // unreadable version file: refuse, untouched
  d = mk(); fs.writeFileSync(path.join(d, 'format-version'), 'banana');
  await assert.rejects(() => migrateConfigDir(d), ConfigMigrationError);

  // read-only config dir, nothing to migrate: still starts
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    d = mk();
    fs.chmodSync(d, 0o555);
    try { r = await migrateConfigDir(d); assert.deepStrictEqual(r, { from: 1, to: 1 }); }
    finally { fs.chmodSync(d, 0o755); }
  }

  console.log('config-migrations: ok');
})().catch((e) => { console.error(e); process.exit(1); });
