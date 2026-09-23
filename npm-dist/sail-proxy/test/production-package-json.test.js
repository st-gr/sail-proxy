#!/usr/bin/env node
/**
 * The bundled gateway and Ollama install their production dependencies with plain npm, which knows
 * nothing about the root's pnpm.overrides (the CVE pins). scripts/create-production-package-json.js
 * forwards them. A pinned package the service depends on DIRECTLY needs two things: its own version
 * pinned, and an npm override "$<name>" so the copies other packages bring along follow the same pin.
 * Without the second, express 4.22.0 kept its own qs@6.14.2 (three advisories) beside the pinned
 * qs@6.16.0 in the published package, while the Docker image, installed by pnpm, had only 6.16.0.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.resolve(__dirname, '..', 'scripts', 'create-production-package-json.js');
const rootOverrides = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')).pnpm.overrides;

let f = 0;
function check(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { f++; console.error('not ok - ' + name + '\n  ' + e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-pkg-'));
const input = path.join(dir, 'in.json');
const output = path.join(dir, 'out.json');
fs.writeFileSync(input, JSON.stringify({
  name: 'gateway', version: '0.0.0',
  dependencies: { express: '^4.21.0', qs: '^6.11.2', 'left-pad': '^1.3.0' },
  devDependencies: { jest: '^29.0.0' }
}));
execFileSync('node', [script, input, output], { stdio: 'pipe' });
const out = JSON.parse(fs.readFileSync(output, 'utf8'));

check('a pinned direct dependency is pinned to the root override', () => {
  assert.strictEqual(out.dependencies.qs, rootOverrides.qs);
  assert.strictEqual(out.dependencies.express, rootOverrides.express);
});
check('every copy of a pinned direct dependency follows the pin ("$name" override)', () => {
  assert.strictEqual(out.overrides.qs, '$qs');
  assert.strictEqual(out.overrides.express, '$express');
});
check('an unpinned direct dependency keeps its range and gets no override', () => {
  assert.strictEqual(out.dependencies['left-pad'], '^1.3.0');
  assert.ok(!('left-pad' in out.overrides));
});
check('a transitive pin is forwarded as a plain override; pnpm parent>child keys are dropped', () => {
  assert.strictEqual(out.overrides.tmp, rootOverrides.tmp);
  assert.ok(Object.keys(out.overrides).every((k) => !k.includes('>')));
});
check('dev dependencies are not carried over', () => {
  assert.ok(!('devDependencies' in out));
});

fs.rmSync(dir, { recursive: true, force: true });
process.exit(f ? 1 : 0);
