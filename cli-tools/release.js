#!/usr/bin/env node

/**
 * One-command release: version bump → sail-proxy npm publish → Docker build + push.
 *
 * Chains the four existing release building blocks in the correct order, with
 * preflight checks and a test gate so a release cannot ship untested code or
 * mismatched versions:
 *
 *   1. Preflight  – clean git tree, npm auth (unless --skip-npm), docker
 *                   daemon reachable (unless --skip-docker)
 *   2. Test gate  – pnpm test (gateway suite; skip with --skip-tests)
 *   3. Bump       – npm version <type>; the root "version" lifecycle hook
 *                   (cli-tools/sync-version.js --stage) syncs every workspace
 *                   manifest into the version commit + tag
 *   4. Publish    – cli-tools/publish-npm.js (hardened wrapper; rebuilds and
 *                   re-bundles the gateway via sail-proxy's prepublishOnly)
 *   5. Docker     – docker/scripts/build-and-tag.js && push-images.js
 *
 * Usage: node cli-tools/release.js <patch|minor|major> [options]
 * Options:
 *   --skip-tests   Skip the test gate (not recommended)
 *   --skip-npm     Skip sail-proxy npm publish
 *   --skip-docker  Skip Docker image build + push
 *   --dry-run      Print the plan and run preflight checks only
 *
 * This script never pushes git commits or tags — it prints the exact
 * `git push` commands at the end so the operator stays in control.
 */

const { execSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

const BUMP_TYPES = ['patch', 'minor', 'major'];
const args = process.argv.slice(2);
const bumpType = args.find(a => BUMP_TYPES.includes(a));
const skipTests = args.includes('--skip-tests');
const skipNpm = args.includes('--skip-npm');
const skipDocker = args.includes('--skip-docker');
const dryRun = args.includes('--dry-run');

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

function run(cmd, label) {
  console.log(`\n▶ ${label}\n  $ ${cmd}`);
  execSync(cmd, { cwd: projectRoot, stdio: 'inherit' });
}

function capture(cmd) {
  return execSync(cmd, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

if (!bumpType) {
  fail(`Usage: node cli-tools/release.js <patch|minor|major> [--skip-tests] [--skip-npm] [--skip-docker] [--dry-run]`);
}

console.log(`\n🚀 Release plan (${bumpType} bump)`);
console.log(`   1. Preflight checks`);
console.log(`   2. Test gate${skipTests ? ' — SKIPPED (--skip-tests)' : ''}`);
console.log(`   3. Version bump + workspace sync + git commit/tag`);
console.log(`   4. sail-proxy npm publish${skipNpm ? ' — SKIPPED (--skip-npm)' : ''}`);
console.log(`   5. Docker image build + push${skipDocker ? ' — SKIPPED (--skip-docker)' : ''}`);

// ---------------------------------------------------------------------------
// 1. Preflight
// ---------------------------------------------------------------------------
console.log(`\n🔍 Preflight checks`);

// Untracked files (scratch, local plan drafts) don't affect the release
// artifacts — only tracked modifications block.
const gitStatus = capture('git status --porcelain --untracked-files=no');
if (gitStatus) {
  fail(`Working tree has uncommitted tracked changes — commit or stash first:\n${gitStatus}`);
}
console.log('  ✓ Git working tree clean (tracked files)');

const branch = capture('git branch --show-current');
console.log(`  ✓ On branch '${branch}' — the version commit and tag land here`);

if (!skipNpm) {
  try {
    const npmUser = capture('npm whoami');
    console.log(`  ✓ npm authenticated as '${npmUser}'`);
  } catch {
    fail(`Not logged in to npm (npm whoami failed). Run 'npm login' or pass --skip-npm.`);
  }
}

if (!skipDocker) {
  try {
    execSync('docker info', { cwd: projectRoot, stdio: 'ignore' });
    console.log('  ✓ Docker daemon reachable');
  } catch {
    fail(`Docker daemon not reachable. Start Docker (and 'docker login <registry>') or pass --skip-docker.`);
  }
  console.log('  ℹ Push requires a prior docker login to the target registry (default ghcr.io)');
}

if (dryRun) {
  console.log('\n✅ Dry run complete — preflight passed, nothing executed.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Test gate
// ---------------------------------------------------------------------------
if (skipTests) {
  console.log('\n⚠️  Test gate skipped (--skip-tests)');
} else {
  run('pnpm test', 'Test gate (gateway suite)');
}

// ---------------------------------------------------------------------------
// 3. Version bump (root "version" hook syncs + stages all workspace manifests)
// ---------------------------------------------------------------------------
run(`npm version ${bumpType}`, `Version bump (${bumpType}) + workspace sync + commit/tag`);
const version = require(path.join(projectRoot, 'package.json')).version;
console.log(`  ✓ Now at v${version}`);

// ---------------------------------------------------------------------------
// 4. sail-proxy npm publish
// ---------------------------------------------------------------------------
if (skipNpm) {
  console.log('\n⚠️  npm publish skipped (--skip-npm)');
} else {
  run('node cli-tools/publish-npm.js', 'Publish sail-proxy to npm (rebuilds + re-bundles gateway)');
}

// ---------------------------------------------------------------------------
// 5. Docker build + push
// ---------------------------------------------------------------------------
if (skipDocker) {
  console.log('\n⚠️  Docker build/push skipped (--skip-docker)');
} else {
  run('node docker/scripts/build-and-tag.js', `Build Docker images (v${version} + latest)`);
  run('node docker/scripts/push-images.js', 'Push Docker images to registry');
}

// ---------------------------------------------------------------------------
// Done — leave git push to the operator
// ---------------------------------------------------------------------------
console.log(`\n✅ Release v${version} complete.`);
console.log(`\nRemaining manual step — push the version commit and tag:`);
console.log(`  git push origin ${branch} && git push origin v${version}`);
