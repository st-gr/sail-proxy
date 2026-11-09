// The release kit: the slice of the repo that the kyma/docker setup code needs, shipped as
// package data so `sail-proxy upgrade` can run that release's own setup code without a git clone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const kitDir = path.join(pkgRoot, 'release-kit');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'scripts', 'release-kit.json'), 'utf8'));

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

fs.rmSync(kitDir, { recursive: true, force: true });
execFileSync('node', [path.join(pkgRoot, 'scripts', 'copy-release-kit.js')], { stdio: 'inherit' });

// Every listed path exists, and each carries a reason
for (const entry of manifest.files) {
  assert.ok(entry.reason && entry.reason.length > 5, `${entry.path} has a reason`);
  assert.ok(fs.existsSync(path.join(kitDir, entry.path)), `kit contains ${entry.path}`);
}
const listed = new Set(manifest.files.map(e => e.path));
const inKit = walk(kitDir);
assert.deepStrictEqual(inKit.filter(f => !listed.has(f)), [], 'nothing in the kit outside the list');

// No secrets or local state: only .env.sample, plus the tracked provider/shared templates
// under docker/configs/ that setup-docker.js copies by name.
for (const f of inKit) {
  if (/(^|\/)\.env($|\.)/.test(f)) {
    assert.ok(/\.env\.sample$/.test(f) || f.startsWith('docker/configs/'), `unexpected env file in kit: ${f}`);
  }
  assert.ok(!f.startsWith('kyma/deployments/'), `deployments in kit: ${f}`);
  assert.ok(!f.startsWith('kyma/manifests/'), `rendered manifests in kit: ${f}`);
  assert.ok(!/node_modules/.test(f), `node_modules in kit: ${f}`);
  assert.ok(!/^docker\/\.env/.test(f), `docker env in kit: ${f}`);
  if (/^kyma\/templates\/(secrets|configmaps)\//.test(f)) {
    assert.ok(/\.template$|\.gitkeep$/.test(f), `rendered file in kit: ${f}`);
  }
}

// Every tracked Kyma manifest template is listed (a new template must not be forgotten)
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files', 'kyma/templates/manifests'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(f => f && !f.endsWith('.md'));
} catch { /* no git: skip the drift check */ }
for (const f of tracked) assert.ok(listed.has(f), `tracked template ${f} missing from release-kit.json`);

// package.json is reduced, the policy is present and matches both Postgres images
const reduced = JSON.parse(fs.readFileSync(path.join(kitDir, 'package.json'), 'utf8'));
assert.deepStrictEqual(Object.keys(reduced).sort(), ['name', 'version']);
const policy = JSON.parse(fs.readFileSync(path.join(kitDir, 'upgrade-policy.json'), 'utf8'));
assert.deepStrictEqual(Object.keys(policy).sort(), ['minUpgradeFrom', 'postgresImage', 'storageLayoutChange']);
const imageIn = (file, re) => fs.readFileSync(path.join(kitDir, file), 'utf8').match(re)[1];
assert.strictEqual(imageIn('kyma/templates/manifests/core/postgres.yaml', /^\s*image:\s*(pgvector\S+)/m), policy.postgresImage);
assert.strictEqual(imageIn('docker/docker-compose.yml', /^\s*image:\s*(pgvector\S+)/m), policy.postgresImage);

// materializeKit copies the kit to a temp dir whose scripts load without prompting or installing
const { materializeKit } = require('../dist/upgrade/kit');
(async () => {
  const kit = await materializeKit();
  try {
    assert.deepStrictEqual(kit.policy, policy);
    assert.ok(process.env.SAIL_PROXY_KIT_MODULES, 'kit modules path exported');
    const probe = `
      const [kitRoot] = process.argv.slice(1);
      const exit = process.exit; process.exit = (c) => { throw new Error('process.exit(' + c + ')'); };
      for (const rel of ['kyma/scripts/setup-kyma.js', 'docker/setup-docker.js', 'cli-tools/kyma-db-manager.js']) {
        process.argv = [process.argv[0], require('path').join(kitRoot, rel)];
        require(require('path').join(kitRoot, rel));
      }
      const loaded = Object.keys(require.cache).filter(k => /node_modules[\\\\/](inquirer|js-yaml|commander)[\\\\/]/.test(k));
      console.log(JSON.stringify(loaded.map(k => k.replace(/\\\\/g, '/').replace(/.*node_modules\\//, '').split('/')[0])));`;
    const out = execFileSync('node', ['-e', probe, kit.root], {
      cwd: kit.root, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SAIL_PROXY_KIT_MODULES: process.env.SAIL_PROXY_KIT_MODULES },
    });
    const loaded = JSON.parse(out.trim().split('\n').pop());
    for (const name of ['inquirer', 'js-yaml', 'commander']) {
      assert.ok(loaded.includes(name), `${name} resolved from the package`);
    }
  } finally {
    await kit.cleanup();
  }
  assert.ok(!fs.existsSync(kit.root), 'cleanup removes the temp copy');
  assert.strictEqual(process.env.SAIL_PROXY_KIT_MODULES, undefined, 'cleanup restores the env');
  console.log('release-kit tests passed');
})().catch(e => { console.error(e); process.exit(1); });
