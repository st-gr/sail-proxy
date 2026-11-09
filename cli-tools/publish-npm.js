#!/usr/bin/env node

/**
 * Publish npm-dist/sail-proxy to npmjs.com.
 *
 * The bug this script defends against: npm publish (npm/cli's lib/commands/publish.js)
 * re-reads package.json from disk AFTER pack() returns, and ships THAT manifest to
 * the registry. If a postpack hook restores workspace:* between the tarball being
 * built and the manifest being re-read, the tarball is correct but the registry
 * metadata gets workspace:*, and `npm install` fails with EUNSUPPORTEDPROTOCOL.
 *
 * Defenses:
 *   1. The npm-dist/sail-proxy package.json must NOT have a postpack hook that
 *      restores workspace:* — verified below.
 *   2. We pre-rewrite workspace:* before invoking npm publish (prepack does this
 *      too, so it's defense in depth).
 *   3. We verify the on-disk dependency state matches what we expect to ship,
 *      ABORTING if any @sap-llm-gateway dep still has workspace:*.
 *   4. The wrapper restores workspace:* in a finally block so the working tree
 *      is clean whether publish succeeded, failed, or the user interrupted.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const pkgDir = path.join(projectRoot, 'npm-dist', 'sail-proxy');
const pkgJsonPath = path.join(pkgDir, 'package.json');
const prepareForPack = require('./prepare-for-pack');
const restoreWorkspace = require('./restore-workspace-protocol');

function run(cmd) {
  execSync(cmd, { cwd: pkgDir, stdio: 'inherit' });
}

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
}

function assertNoPostpackHook() {
  const pkg = readPkg();
  if (pkg.scripts && pkg.scripts.postpack) {
    throw new Error(
      `Refusing to publish: npm-dist/sail-proxy/package.json has a postpack hook ` +
      `(${pkg.scripts.postpack}). npm publish re-reads package.json from disk after ` +
      `pack() runs, so a postpack hook that restores workspace:* will poison the ` +
      `registry manifest while leaving the tarball correct. Remove the postpack ` +
      `hook — the wrapper's finally block handles workspace:* restoration after ` +
      `publish completes.`
    );
  }
}

function assertNoWorkspaceProtocol(stage) {
  const pkg = readPkg();
  const offenders = [];
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      offenders.push(`${name}: ${version}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to publish: ${stage}, package.json still has workspace: protocol in ` +
      `dependencies:\n  ${offenders.join('\n  ')}\n` +
      `This is the exact state npm publish would re-read for the registry manifest. ` +
      `Run prepare-for-pack.js or check that the prepack hook is wired up.`
    );
  }
}

let exitCode = 0;
let cleanupNeeded = false;

try {
  run('npm run check-version');

  // Defense 1: bail early if the postpack-restore footgun is back.
  assertNoPostpackHook();

  // Defense 2: rewrite workspace:* before npm publish reads the file.
  prepareForPack.main();
  cleanupNeeded = true;

  // Defense 3: verify on-disk state is publishable.
  // This is the same disk state npm's publish.js will re-read at line 112
  // (after pack/postpack runs) for the registry manifest.
  assertNoWorkspaceProtocol('after prepare-for-pack');

  const extraArgs = process.argv.slice(2).join(' ');
  run(`npm publish${extraArgs ? ' ' + extraArgs : ''}`);
} catch (err) {
  if (err && err.message && err.message.startsWith('Refusing to publish')) {
    console.error('\n❌ ' + err.message);
    exitCode = 1;
  } else {
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }
} finally {
  if (cleanupNeeded) {
    try {
      restoreWorkspace.main();
    } catch (cleanupErr) {
      console.error('⚠️  Cleanup (restore-workspace-protocol) failed:', cleanupErr.message);
      if (exitCode === 0) exitCode = 1;
    }
  }
}

process.exit(exitCode);
