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

// A version-scoped root override ("uuid@11") that targets the service's own direct dependency must
// pin it like a bare-name override: forwarded as-is, npm rejects it (EOVERRIDE, "conflicts with
// direct dependency") and the bundle fails. One for another major passes through untouched.
function runScoped(rootOverrides, dependencies) {
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'npm-dist', 'sail-proxy', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9', pnpm: { overrides: rootOverrides } }));
  const scriptCopy = path.join(root, 'npm-dist', 'sail-proxy', 'scripts', 'create-production-package-json.js');
  fs.copyFileSync(script, scriptCopy);
  const inPath = path.join(dir, 'scoped-in.json');
  const outPath = path.join(dir, 'scoped-out.json');
  fs.writeFileSync(inPath, JSON.stringify({ name: 'gateway', version: '0.0.0', dependencies }));
  execFileSync('node', [scriptCopy, inPath, outPath], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}
check('a version-scoped override of a direct dependency pins it and becomes "$name"', () => {
  const o = runScoped({ 'uuid@11': '>=11.1.1 <12.0.0', '@scope/lib@2': '>=2.3.0 <3.0.0' },
    { uuid: '^11.1.0', '@scope/lib': '~2.1.0' });
  assert.strictEqual(o.dependencies.uuid, '>=11.1.1 <12.0.0');
  assert.strictEqual(o.overrides.uuid, '$uuid');
  assert.ok(!('uuid@11' in o.overrides));
  assert.strictEqual(o.dependencies['@scope/lib'], '>=2.3.0 <3.0.0');
  assert.strictEqual(o.overrides['@scope/lib'], '$@scope/lib');
});
check('a version-scoped override for another major of a direct dependency is forwarded unchanged', () => {
  const o = runScoped({ 'uuid@8': '>=8.3.3 <9.0.0' }, { uuid: '^11.1.0' });
  assert.strictEqual(o.dependencies.uuid, '^11.1.0');
  assert.strictEqual(o.overrides['uuid@8'], '>=8.3.3 <9.0.0');
});

fs.rmSync(dir, { recursive: true, force: true });
process.exit(f ? 1 : 0);
