#!/usr/bin/env node
/**
 * sync-version.js carries the root version into the info.version of the four OpenAPI documents, line-level for the
 * YAML files, and --check-only reports a mismatch in any of them. It runs against a scratch copy of the tree.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-version-'));
fs.mkdirSync(path.join(tmp, 'cli-tools'));
fs.mkdirSync(path.join(tmp, 'openapi'));
fs.copyFileSync(path.join(__dirname, 'sync-version.js'), path.join(tmp, 'cli-tools', 'sync-version.js'));
const write = (rel, text) => fs.writeFileSync(path.join(tmp, rel), text);
const read = rel => fs.readFileSync(path.join(tmp, rel), 'utf8');
const run = (...args) => spawnSync('node', [path.join(tmp, 'cli-tools', 'sync-version.js'), ...args], { encoding: 'utf8' });

const yaml = version => `openapi: 3.1.0\ninfo:\n  title: t\n  version: ${version}   # kept\n  description: |-\n    version: not this one\npaths: {}\nversion: nor this\n`;
write('package.json', JSON.stringify({ name: 'root', version: '2.3.4' }));
for (const name of ['gateway', 'admin-rest', 'ollama']) write(`openapi/${name}.yaml`, yaml('0.10.0'));
write('openapi/admin-odata.json', JSON.stringify({ openapi: '3.0.2', info: { title: 't', version: '1.0.0' }, paths: {} }, null, 2) + '\n');

try {
  const check = run('--check-only');
  assert.strictEqual(check.status, 1, check.stdout + check.stderr);
  for (const name of ['gateway.yaml', 'admin-rest.yaml', 'ollama.yaml', 'admin-odata.json']) {
    assert.ok(check.stdout.includes(`openapi/${name}: info.version`), `--check-only names ${name}\n${check.stdout}`);
  }
  assert.strictEqual(read('openapi/gateway.yaml'), yaml('0.10.0'), '--check-only writes nothing');

  const fix = run();
  assert.strictEqual(fix.status, 0, fix.stdout + fix.stderr);
  for (const name of ['gateway', 'admin-rest', 'ollama']) {
    assert.strictEqual(read(`openapi/${name}.yaml`), yaml('2.3.4'), `${name}.yaml: only the info.version value changes`);
  }
  const odata = JSON.parse(read('openapi/admin-odata.json'));
  assert.strictEqual(odata.info.version, '2.3.4');
  assert.strictEqual(odata.info.title, 't');
  assert.strictEqual(run('--check-only').status, 0, 'synchronized after the fix');

  write('openapi/ollama.yaml', 'openapi: 3.1.0\ninfo:\n  title: t\npaths: {}\n');
  const missing = run('--check-only');
  assert.notStrictEqual(missing.status, 0, 'a missing info.version line fails loudly');
  assert.ok(/ollama\.yaml: no "version:" line/.test(missing.stderr), missing.stderr);
  console.log('sync-version.test.js: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
