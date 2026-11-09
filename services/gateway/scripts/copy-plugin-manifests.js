#!/usr/bin/env node
/**
 * The second half of the gateway build. tsc does not copy JSON, so every shipped plugin's manifest.json goes
 * into dist here; without it the loader takes the folder for a helper folder and the plugin silently stops
 * registering. Runs in the Docker build stage too, so it needs nothing but this file and Node.
 *
 * tsc also never deletes: a top-level entry moved into a folder would stay in an existing dist as a second,
 * legacy copy of the plugin. A compiled top-level file without its source is removed for that reason.
 */
const fs = require('fs');
const path = require('path');

const gatewayRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(gatewayRoot, 'src', 'plugins');
const outDir = path.join(gatewayRoot, 'dist', 'services', 'gateway', 'src', 'plugins');

let copied = 0;
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  const manifest = path.join(sourceDir, entry.name, 'manifest.json');
  if (!entry.isDirectory() || !fs.existsSync(manifest)) continue;
  fs.mkdirSync(path.join(outDir, entry.name), { recursive: true });
  fs.copyFileSync(manifest, path.join(outDir, entry.name, 'manifest.json'));
  copied++;
}

for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const base = entry.name.replace(/(\.d\.ts|\.js\.map|\.js)$/, '');
  if (base !== entry.name && !fs.existsSync(path.join(sourceDir, `${base}.ts`))) {
    fs.rmSync(path.join(outDir, entry.name));
    console.log(`Removed stale ${entry.name} from dist`);
  }
}

console.log(`Copied ${copied} plugin manifest(s) into dist`);
