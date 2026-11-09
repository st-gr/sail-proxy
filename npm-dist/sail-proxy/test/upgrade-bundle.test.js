#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require(path.resolve(__dirname, '..', 'dist', 'upgrade', 'bundle.js'));

let failed = 0;
const tests = [];
function check(name, fn) { tests.push([name, fn]); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spbk-test-'));
let n = 0;
const mk = (p) => { const d = path.join(tmp, `${p}${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const PASS = 'correct horse battery';
const base = { format: 1, kind: 'kyma', fromVersion: '0.11.0', toVersion: '0.12.0', createdAt: '2026-11-07T12:34:56.000Z' };

function sources() {
  const d = mk('src');
  const big = path.join(d, 'db.sql.gz');
  const chunk = crypto.randomBytes(1024 * 1024);
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 50; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const a = path.join(d, 'a.yaml'); fs.writeFileSync(a, 'kind: Deployment\n');
  const b = path.join(d, 'empty'); fs.writeFileSync(b, '');
  return [
    { name: 'db.sql.gz', source: big },
    { name: 'previous/Deployment-gateway.yaml', source: a },
    { name: 'empty.bin', source: b },
  ];
}
async function* gen(list) { for (const e of list) yield e; }
function rethrows(promise, code) {
  return promise.then(() => assert.fail('expected rejection ' + code), (e) => {
    assert.ok(e instanceof B.BundleError, 'BundleError expected, got ' + e);
    assert.strictEqual(e.code, code);
  });
}
function entryFiles(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } })(dir);
  return out;
}
let shared;
async function make(pass) {
  shared = shared || sources();
  const file = path.join(mk('out'), 'x.spbk');
  const m = await B.writeBundle(file, pass, base, gen(shared));
  return { file, m };
}

check('round trip, encrypted, 3 entries incl. 50 MB, byte identical, bounded memory', async () => {
  shared = sources();
  const before = process.memoryUsage().rss;
  const { file, m } = await make(PASS);
  assert.strictEqual(m.entries.length, 3);
  assert.strictEqual(m.entries[0].size, 50 * 1024 * 1024);
  const work = mk('work');
  const b = await B.openBundle(file, PASS, work);
  const after = process.memoryUsage().rss;
  assert.ok(after - before < 150 * 1024 * 1024, 'rss grew ' + (after - before));
  for (const e of shared) assert.strictEqual(sha(b.path(e.name)), sha(e.source));
  assert.deepStrictEqual(b.manifest, m);
  assert.strictEqual(b.manifest.kind, 'kyma');
  assert.ok(!fs.existsSync(file + '.partial'));
  assert.ok(fs.readFileSync(file).subarray(0, 7).equals(Buffer.from('SPBK1E\n')));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(b.path('db.sql.gz')).mode & 0o777, 0o600);
  }
});
check('wrong passphrase leaves no entry files', async () => {
  const { file } = await make(PASS);
  const work = mk('work');
  await rethrows(B.openBundle(file, 'another passphrase!!', work), 'BAD_PASSPHRASE_OR_DAMAGED');
  assert.deepStrictEqual(entryFiles(work), []);
});
check('flipped ciphertext byte, truncation, appended byte -> damaged (E)', async () => {
  const { file } = await make(PASS);
  const buf = fs.readFileSync(file);
  const variants = {
    flip: (() => { const c = Buffer.from(buf); c[1000] ^= 1; return c; })(),
    flipTag: (() => { const c = Buffer.from(buf); c[c.length - 1] ^= 1; return c; })(),
    trunc: buf.subarray(0, buf.length - 100),
    append: Buffer.concat([buf, Buffer.from([0])]),
  };
  for (const [k, v] of Object.entries(variants)) {
    const f = path.join(mk('var'), k + '.spbk'); fs.writeFileSync(f, v);
    const work = mk('work');
    await rethrows(B.openBundle(f, PASS, work), 'BAD_PASSPHRASE_OR_DAMAGED');
    assert.deepStrictEqual(entryFiles(work), [], k);
  }
});
check('not a bundle / unsupported format', async () => {
  const d = mk('hdr');
  fs.writeFileSync(path.join(d, 'a'), 'hello world, not a bundle');
  fs.writeFileSync(path.join(d, 'b'), 'SPBK2E\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  fs.writeFileSync(path.join(d, 'c'), '');
  await rethrows(B.openBundle(path.join(d, 'a'), PASS, mk('w')), 'NOT_A_BUNDLE');
  await rethrows(B.openBundle(path.join(d, 'c'), PASS, mk('w')), 'NOT_A_BUNDLE');
  await rethrows(B.openBundle(path.join(d, 'b'), PASS, mk('w')), 'UNSUPPORTED_FORMAT');
});
check('failing source leaves neither .spbk nor .partial', async () => {
  const d = mk('fail');
  const file = path.join(d, 'x.spbk');
  const good = sources().slice(1, 2);
  async function* bad() { yield good[0]; throw new Error('boom'); }
  await assert.rejects(B.writeBundle(file, PASS, base, bad()), /boom/);
  assert.deepStrictEqual(fs.readdirSync(d), []);
  // a missing source file also cleans up
  await assert.rejects(B.writeBundle(file, null, base, gen([{ name: 'x', source: path.join(d, 'nope') }])));
  assert.deepStrictEqual(fs.readdirSync(d), []);
});
check('mode P round trip, flipped byte fails sha256', async () => {
  const { file } = await make(null);
  assert.ok(fs.readFileSync(file).subarray(0, 7).equals(Buffer.from('SPBK1P\n')));
  const b = await B.openBundle(file, 'ignored passphrase', mk('work'));
  for (const e of shared) assert.strictEqual(sha(b.path(e.name)), sha(e.source));
  const buf = fs.readFileSync(file);
  for (const pos of [5000, buf.length - 10]) {
    const c = Buffer.from(buf); c[pos] ^= 1;
    const f = path.join(mk('var'), 'p.spbk'); fs.writeFileSync(f, c);
    const work = mk('work');
    await rethrows(B.openBundle(f, null, work), 'BAD_PASSPHRASE_OR_DAMAGED');
    assert.deepStrictEqual(entryFiles(work), []);
  }
  const f = path.join(mk('var'), 't.spbk'); fs.writeFileSync(f, buf.subarray(0, buf.length - 5));
  await rethrows(B.openBundle(f, null, mk('work')), 'BAD_PASSPHRASE_OR_DAMAGED');
  const g = path.join(mk('var'), 'a.spbk'); fs.writeFileSync(g, Buffer.concat([buf, Buffer.from([1])]));
  await rethrows(B.openBundle(g, null, mk('work')), 'BAD_PASSPHRASE_OR_DAMAGED');
});
check('mode E opened with null -> PASSPHRASE_REQUIRED', async () => {
  const { file } = await make(PASS);
  await rethrows(B.openBundle(file, null, mk('work')), 'PASSPHRASE_REQUIRED');
});
check('I/O errors during extract propagate (not BAD_PASSPHRASE), leave no temp or entry files', async () => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
  for (const pass of [PASS, null]) {
    const { file } = await make(pass);
    const work = mk('work');
    fs.mkdirSync(path.join(work, 'previous'));
    fs.chmodSync(path.join(work, 'previous'), 0o500); // 2nd entry cannot be written
    try {
      await assert.rejects(B.openBundle(file, pass, work), (e) => !(e instanceof B.BundleError) && e.code === 'EACCES');
    } finally { fs.chmodSync(path.join(work, 'previous'), 0o700); }
    assert.deepStrictEqual(entryFiles(work), []);
    const ro = mk('ro');
    fs.chmodSync(ro, 0o500);
    try {
      await assert.rejects(B.openBundle(file, pass, path.join(ro, 'sub')), (e) => !(e instanceof B.BundleError) && e.code === 'EACCES');
    } finally { fs.chmodSync(ro, 0o700); }
  }
});
check('a failed open does not leave the input open', async () => {
  if (!fs.existsSync('/dev/fd')) return;
  const { file } = await make(null);
  const buf = fs.readFileSync(file);
  buf[buf.length - 10] ^= 1;
  const bad = path.join(mk('var'), 'bad.spbk'); fs.writeFileSync(bad, buf);
  const { file: enc } = await make(PASS);
  const before = fs.readdirSync('/dev/fd').length;
  for (let i = 0; i < 5; i++) {
    await rethrows(B.openBundle(bad, null, mk('work')), 'BAD_PASSPHRASE_OR_DAMAGED');
    await rethrows(B.openBundle(enc, 'wrong passphrase here', mk('work')), 'BAD_PASSPHRASE_OR_DAMAGED');
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.readdirSync('/dev/fd').length <= before, 'fd leak');
});
check('unsafe entry names are rejected on write', async () => {
  const src = sources()[1].source;
  for (const name of ['../x', '/abs', 'a\\b', 'a/../b', '']) {
    const dir = mk('o');
    await assert.rejects(B.writeBundle(path.join(dir, 'x.spbk'), null, base, gen([{ name, source: src }])), undefined, name);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${name}: no .partial left (its stream is closed before the remove, as Windows needs)`);
  }
});
check('resolvePassphrase', async () => {
  const noPrompt = async () => assert.fail('must not prompt');
  assert.strictEqual(await B.resolvePassphrase({ encrypt: false, confirm: true, env: {}, prompt: noPrompt }), null);
  assert.strictEqual(await B.resolvePassphrase({ encrypt: true, confirm: true, env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASS }, prompt: noPrompt }), PASS);
  await assert.rejects(B.resolvePassphrase({ encrypt: true, confirm: false, env: { SAIL_PROXY_BACKUP_PASSPHRASE: 'short' }, prompt: noPrompt }), /12/);
  assert.strictEqual(B.MIN_PASSPHRASE, 12);
  const calls = [];
  const answers = [PASS, PASS];
  const prompt = async (q) => { calls.push(q); return { passphrase: answers.shift() }; };
  assert.strictEqual(await B.resolvePassphrase({ encrypt: true, confirm: true, env: {}, prompt }), PASS);
  assert.strictEqual(calls.length, 2);
  for (const q of calls) { const o = [].concat(q)[0]; assert.strictEqual(o.type, 'password'); assert.strictEqual(o.mask, '*'); }
  const once = [];
  assert.strictEqual(await B.resolvePassphrase({ encrypt: true, confirm: false, env: {}, prompt: async (q) => { once.push(q); return { passphrase: PASS }; } }), PASS);
  assert.strictEqual(once.length, 1);
  const mism = [PASS, 'a different passphrase'];
  await assert.rejects(B.resolvePassphrase({ encrypt: true, confirm: true, env: {}, prompt: async () => ({ passphrase: mism.shift() }) }), /match/i);
  await assert.rejects(B.resolvePassphrase({ encrypt: true, confirm: false, env: {}, prompt: async () => ({ passphrase: 'tiny' }) }), /12/);
});
check('backupFileName', () => {
  assert.strictEqual(B.backupFileName('sail-proxy-test', '0.11.0', new Date('2026-11-07T12:34:56Z')), 'sail-proxy-test-0.11.0-20261107T123456Z.spbk');
  const s = B.backupFileName('a/b\\c:d e', '0.11.0', new Date('2026-11-07T12:34:56Z'));
  assert.ok(/^[A-Za-z0-9._-]+$/.test(s), s);
  assert.ok(s.endsWith('-0.11.0-20261107T123456Z.spbk'));
});
check('defaultBackupDir', () => {
  const saved = { dir: process.env.SAIL_PROXY_CONFIG_DIR, app: process.env.APPDATA, plat: Object.getOwnPropertyDescriptor(process, 'platform') };
  try {
    process.env.SAIL_PROXY_CONFIG_DIR = path.join(tmp, 'cfg');
    assert.strictEqual(B.defaultBackupDir(), path.join(tmp, 'cfg', 'backups'));
    delete process.env.SAIL_PROXY_CONFIG_DIR;
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const d = B.defaultBackupDir();
    assert.strictEqual(path.basename(d), 'backups');
    assert.ok(d.includes('sail-proxy'));
    assert.ok(d.startsWith('C:\\Users\\x\\AppData\\Roaming'.replace(/\\/g, path.sep)) || d.startsWith('C:\\Users\\x\\AppData\\Roaming'), d);
  } finally {
    Object.defineProperty(process, 'platform', saved.plat);
    if (saved.dir === undefined) delete process.env.SAIL_PROXY_CONFIG_DIR; else process.env.SAIL_PROXY_CONFIG_DIR = saved.dir;
    if (saved.app === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.app;
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + (e && e.stack || e)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
