#!/usr/bin/env node

/**
 * Build the API reference page directory the admin serves at /api/docs/.
 *
 * Usage: node cli-tools/copy-api-docs.js [--ui=<file,...>] <outDir> <doc...>
 *
 * Copies the Swagger UI files (all three, or only those named by --ui, for a page that loads fewer) from the pinned swagger-ui-dist package (resolved from the current
 * directory, so run it from services/admin) and each named OpenAPI document into <outDir>.
 * Exits non-zero when a file is missing. The page itself (index.html, init.js) is served by
 * services/admin/src/srv/api-docs.ts.
 */

const fs = require('fs');
const path = require('path');

const ALL_UI_FILES = ['swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'swagger-ui.css'];

function fail(message) {
  console.error(`copy-api-docs: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const uiFlag = args.find(a => a.startsWith('--ui='));
const [outDir, ...docs] = args.filter(a => a !== uiFlag);
if (!outDir || docs.length === 0) fail('usage: copy-api-docs.js [--ui=<file,...>] <outDir> <doc...>');

const UI_FILES = uiFlag === undefined ? ALL_UI_FILES : uiFlag.slice('--ui='.length).split(',').filter(Boolean);
const unknown = UI_FILES.filter(f => !ALL_UI_FILES.includes(f));
if (UI_FILES.length === 0 || unknown.length > 0) fail(`--ui takes some of ${ALL_UI_FILES.join(', ')}`);

let uiDir;
try {
  uiDir = path.dirname(require.resolve('swagger-ui-dist/package.json', { paths: [process.cwd()] }));
} catch {
  fail(`swagger-ui-dist is not installed where ${process.cwd()} resolves packages`);
}

const sources = [...UI_FILES.map(f => path.join(uiDir, f)), ...docs.map(d => path.resolve(d))];
const missing = sources.filter(s => !fs.existsSync(s));
if (missing.length > 0) fail(`missing file(s): ${missing.join(', ')}`);

fs.mkdirSync(outDir, { recursive: true });
for (const source of sources) {
  fs.copyFileSync(source, path.join(outDir, path.basename(source)));
}
console.log(`copy-api-docs: ${sources.length} files -> ${outDir}`);
