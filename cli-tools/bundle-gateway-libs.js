#!/usr/bin/env node

/**
 * Populate npm-dist/sail-proxy/bundled/gateway/node_modules/@libs/<name>/ from
 * the already-bundled bundled/gateway/libs/<name>/ tree.
 *
 * The gateway's TypeScript sources use `import ... from '@libs/<name>'` and the
 * tsconfig defines `paths: { "@libs/*": ["libs/*"] }`. tsc does not rewrite path
 * aliases on emit, so the compiled JS still contains literal `require("@libs/...")`.
 * In production the only way to resolve those without a runtime path-mapper is
 * Node's standard module resolution — which means each lib must appear under
 * `node_modules/@libs/<name>/`.
 *
 * The Docker image accomplishes this with a symlink (`ln -sf ./libs node_modules/@libs`).
 * Internal symlinks in npm tarballs are unreliable cross-platform (Windows in
 * particular), so this script does a real copy. Libs are tens of KB total.
 *
 * Must run AFTER `npm install --production` in bundled/gateway/, otherwise
 * npm's pruning pass would strip our @libs entries as "extraneous".
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const gatewayBundleDir = path.join(projectRoot, 'npm-dist', 'sail-proxy', 'bundled', 'gateway');
const libsSrc = path.join(gatewayBundleDir, 'libs');
const libsDst = path.join(gatewayBundleDir, 'node_modules', '@libs');

function main() {
  if (!fs.existsSync(libsSrc)) {
    throw new Error(
      `bundled/gateway/libs not found at ${libsSrc} — bundle:gateway must run before bundle:gateway-aliases.`
    );
  }

  fs.rmSync(libsDst, { force: true, recursive: true });
  fs.mkdirSync(libsDst, { recursive: true });

  const entries = fs.readdirSync(libsSrc, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(libsSrc, entry.name);
    const dst = path.join(libsDst, entry.name);
    fs.cpSync(src, dst, { recursive: true });
    copied.push(entry.name);
  }

  if (copied.length === 0) {
    throw new Error(`No lib subdirectories found under ${libsSrc}`);
  }

  console.log(
    `✅ Mirrored ${copied.length} libs into ${path.relative(projectRoot, libsDst)}: ${copied.join(', ')}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ bundle-gateway-libs failed:', err.message);
    process.exit(1);
  }
}

module.exports = { main };
