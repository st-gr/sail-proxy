#!/usr/bin/env node
/**
 * Packs a compiled plugin folder into an installable zip.
 *
 *   node cli-tools/package-plugin.js --dir <compiled plugin dir> --out <zip> [--id <id>]
 *
 * Leaves out what a package must not hold but a build leaves behind (.d.ts, .js.map, the install marker, .DS_Store) and
 * validates the result with the same parser the gateway and admin use, so a zip that is written can be
 * installed. --id replaces the manifest id in the zip only. Runs from a repository checkout.
 */
const fs = require('fs');
const path = require('path');
const { register } = require('ts-node');
const { zipSync } = require('fflate');

register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'ES2022', esModuleInterop: true },
});
const { parsePluginPackage, validateManifest } = require('../libs/plugin-package');

const USAGE = 'Usage: node cli-tools/package-plugin.js --dir <compiled plugin dir> --out <zip> [--id <id>]';
const STRIPPED = /(\.d\.ts|\.js\.map)$/i;
const MARKER = '.installed.json';
const JUNK = '.DS_Store';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = { '--dir': 'dir', '--out': 'out', '--id': 'id' }[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(USAGE);
    args[name] = argv[i + 1];
  }
  if (!args.dir || !args.out) throw new Error(USAGE);
  return args;
}

/** Files of a folder as zip paths (forward slashes), without the stripped ones. A symlink is refused. */
function collect(root, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlinks are not allowed: ${relative}`);
    if (entry.isDirectory()) Object.assign(files, collect(root, relative));
    else if (!STRIPPED.test(entry.name) && relative !== MARKER && entry.name !== JUNK) files[relative] = fs.readFileSync(path.join(root, relative));
  }
  return files;
}

function main() {
  const { dir, out, id } = parseArgs(process.argv.slice(2));
  const files = collect(path.resolve(dir));
  if (!files['manifest.json']) throw new Error(`no manifest.json in ${dir}`);
  if (id !== undefined) {
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    files['manifest.json'] = Buffer.from(JSON.stringify(validateManifest({ ...manifest, id }), null, 2));
  }
  const zip = zipSync(files);
  const { manifest } = parsePluginPackage(zip);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, zip);
  console.log(`Packed ${manifest.id} ${manifest.version} (${Object.keys(files).length} files, ${zip.length} bytes) into ${out}`);
}

try {
  main();
} catch (error) {
  console.error(`package-plugin: ${error.message}`);
  process.exit(1);
}
