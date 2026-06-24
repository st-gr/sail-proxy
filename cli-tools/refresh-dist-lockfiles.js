#!/usr/bin/env node

/**
 * Regenerate the distribution lockfiles from scratch so the Dependabot
 * dashboard reflects the current manifests/overrides.
 *
 *   - docker/pnpm-lock.yaml            (closure of docker/package.json)
 *   - npm-dist/sail-proxy/pnpm-lock.yaml (closure of the published npm package)
 *
 * Neither lockfile is a build input — the Docker images install with
 * --no-frozen-lockfile and never copy a lockfile, and the npm tarball does
 * not ship its lockfile. They exist only so Dependabot scans the same
 * versions production actually resolves. A *from-scratch* resolve is required:
 * `pnpm install` against an existing lockfile keeps stale-but-in-range
 * versions, so the patched releases would never be picked up otherwise.
 *
 * Both lockfiles are generated in isolated temp directories. The tracked
 * package.json files are never modified, so a crash can't leave the published
 * manifest in a half-substituted state.
 *
 * Usage:
 *   node cli-tools/refresh-dist-lockfiles.js            # write the lockfiles
 *   node cli-tools/refresh-dist-lockfiles.js --dry-run  # report only, no writes
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

// pnpm version pinned by the repo, so temp installs use the same resolver.
const packageManager = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
).packageManager;

function pnpmInstall(cwd) {
  const res = spawnSync(
    'pnpm',
    ['install', '--lockfile-only', '--ignore-workspace', '--ignore-scripts', '--config.confirmModulesPurge=false'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }
  );
  if (res.status !== 0) {
    throw new Error(`pnpm install failed in ${cwd}:\n${(res.stderr || res.stdout || '').trim()}`);
  }
}

function mkTemp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dist-lock-${label}-`));
}

// Assert every (pkg, minVersion) actually resolved to >= minVersion. Guards
// against silently shipping a lockfile that still pins a vulnerable version.
function assertPatched(lockText, lockfileName, expectations) {
  for (const [pkg, min] of Object.entries(expectations)) {
    const versions = [...lockText.matchAll(new RegExp(`(?:^|/| )${pkg.replace(/[/\\]/g, '\\$&')}@(\\d[\\d.]*)`, 'g'))]
      .map((m) => m[1]);
    if (versions.length === 0) {
      console.log(`   ⚠️  ${lockfileName}: ${pkg} not present (nothing to check)`);
      continue;
    }
    const bad = versions.filter((v) => cmpSemver(v, min) < 0);
    if (bad.length) {
      throw new Error(`${lockfileName}: ${pkg} resolved to ${[...new Set(bad)].join(', ')} (expected >= ${min})`);
    }
    console.log(`   ✓ ${lockfileName}: ${pkg} >= ${min} (found ${[...new Set(versions)].sort().join(', ')})`);
  }
}

function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Write the regenerated lockfile (or report the diff under --dry-run).
function commit(targetRel, newText) {
  const target = path.join(projectRoot, targetRel);
  const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (old === newText) {
    console.log(`   = ${targetRel} already up to date`);
    return false;
  }
  if (dryRun) {
    console.log(`   ~ ${targetRel} would change (dry-run, not written)`);
    return true;
  }
  fs.writeFileSync(target, newText);
  console.log(`   ✅ wrote ${targetRel}`);
  return true;
}

// docker/package.json has no workspace deps — a plain standalone install.
function regenDocker() {
  console.log('\n📦 docker/pnpm-lock.yaml');
  const tmp = mkTemp('docker');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docker/package.json'), 'utf8'));
    pkg.packageManager = packageManager;
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
    pnpmInstall(tmp);
    const lock = fs.readFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'utf8');
    assertPatched(lock, 'docker', {
      qs: '6.15.2',
      'form-data': '4.0.6',
      'http-proxy-middleware': '3.0.7',
    });
    return commit('docker/pnpm-lock.yaml', lock);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// npm-dist/sail-proxy depends on the local service-key-parser via workspace:*.
// Outside the workspace we substitute a link: to the real lib so pnpm resolves
// it without the registry, then normalize the lockfile back to the committed
// representation (specifier: workspace:*, version: link:../../libs/...).
function regenNpmDist() {
  console.log('\n📦 npm-dist/sail-proxy/pnpm-lock.yaml');
  const tmp = mkTemp('npmdist');
  try {
    const srcDir = path.join(projectRoot, 'npm-dist/sail-proxy');
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
    pkg.packageManager = packageManager;

    const libAbs = path.join(projectRoot, 'libs/service-key-parser');
    const linkAbs = `link:${libAbs}`;
    const workspaceDeps = [];
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      if (spec === 'workspace:*') {
        pkg.dependencies[name] = linkAbs;
        workspaceDeps.push(name);
      }
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
    pnpmInstall(tmp);

    let lock = fs.readFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'utf8');
    // pnpm rewrites the link: target relative to the temp install dir, so the
    // raw lockfile points at a temp-relative path. Normalize any resolved form
    // of the link (absolute or temp-relative) back to the canonical relative
    // path, then restore the workspace:* specifier the committed lockfile uses.
    lock = lock.replace(
      /link:[^\s'"]*\/libs\/service-key-parser/g,
      'link:../../libs/service-key-parser'
    );
    lock = lock.replace(
      /specifier: link:\.\.\/\.\.\/libs\/service-key-parser/g,
      'specifier: workspace:*'
    );
    assertPatched(lock, 'npm-dist', { 'form-data': '4.0.6' });
    if (!workspaceDeps.length) console.log('   ⚠️  no workspace:* deps found to substitute');
    return commit('npm-dist/sail-proxy/pnpm-lock.yaml', lock);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  console.log('🔄 Regenerating distribution lockfiles' + (dryRun ? ' (dry-run)' : ''));
  console.log(`   pnpm: ${packageManager}`);
  const changed = [regenDocker(), regenNpmDist()].some(Boolean);
  console.log('\n' + (dryRun
    ? (changed ? '🔍 Dry-run: changes needed (run without --dry-run to write).' : '✅ Dry-run: lockfiles already current.')
    : (changed ? '✅ Done. Review the diff and commit the regenerated lockfiles.' : '✅ Done. Lockfiles already current.')));
}

if (require.main === module) {
  main();
}

module.exports = { main };
