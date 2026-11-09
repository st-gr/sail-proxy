#!/usr/bin/env node
// Copies the files listed in release-kit.json from the repo into release-kit/ (a build output).
// The kit is the slice of the repo that the Kyma/Docker setup code reads, so `sail-proxy upgrade`
// can run this release's own setup code from a temp copy without a git clone.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const kitDir = path.join(pkgRoot, 'release-kit');
const { files } = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-kit.json'), 'utf8'));

fs.rmSync(kitDir, { recursive: true, force: true });

for (const entry of files) {
  const source = path.join(repoRoot, entry.from || entry.path);
  const target = path.join(kitDir, entry.path);
  if (!fs.existsSync(source)) throw new Error(`release-kit.json lists ${entry.from || entry.path}, which does not exist`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.transform === 'name-version') {
    const { name, version } = JSON.parse(fs.readFileSync(source, 'utf8'));
    fs.writeFileSync(target, JSON.stringify({ name, version }, null, 2) + '\n');
  } else {
    fs.copyFileSync(source, target);
  }
}
console.log(`release-kit: ${files.length} files copied to ${path.relative(process.cwd(), kitDir) || '.'}`);
