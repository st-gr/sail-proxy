#!/usr/bin/env node

/**
 * Bundle libs/service-key-parser into npm-dist/sail-proxy as a real node_modules
 * entry (not a symlink) so `npm pack` includes it via bundledDependencies.
 *
 * In a pnpm workspace, npm-dist/sail-proxy/node_modules/@sap-llm-gateway/service-key-parser
 * is a symlink to ../../../../libs/service-key-parser. npm pack does not follow that
 * external symlink even with bundledDependencies set, so the published tarball has
 * no copy of the lib and `npm install @st-gr/sail-proxy` fails with E404 on the dep.
 *
 * This script replaces the symlink with a real directory containing only the built
 * artifacts and a stripped package.json. pnpm install will re-link on next run.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const libDir = path.join(projectRoot, 'libs', 'service-key-parser');
const targetDir = path.join(
  projectRoot,
  'npm-dist',
  'sail-proxy',
  'node_modules',
  '@sap-llm-gateway',
  'service-key-parser'
);

function main() {
  if (!fs.existsSync(libDir)) {
    throw new Error(`libs/service-key-parser not found at ${libDir}`);
  }

  execSync('pnpm build', { cwd: libDir, stdio: 'inherit' });

  const distSrc = path.join(libDir, 'dist');
  if (!fs.existsSync(distSrc)) {
    throw new Error(`Build output missing: ${distSrc}`);
  }

  // Replace symlink (or stale dir) with a fresh real directory.
  fs.rmSync(targetDir, { force: true, recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  fs.cpSync(distSrc, path.join(targetDir, 'dist'), { recursive: true });

  // Ship a minimal package.json — keep main/types/version, drop scripts/devDeps
  // so npm install on the consumer side has nothing to run.
  const libPkg = JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8'));
  const shipped = {
    name: libPkg.name,
    version: libPkg.version,
    main: libPkg.main,
    types: libPkg.types,
    dependencies: libPkg.dependencies || {}
  };
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify(shipped, null, 2) + '\n',
    'utf8'
  );

  console.log(
    `✅ Bundled @sap-llm-gateway/service-key-parser@${libPkg.version} into ${path.relative(projectRoot, targetDir)}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ bundle-service-key-parser failed:', err.message);
    process.exit(1);
  }
}

module.exports = { main };
