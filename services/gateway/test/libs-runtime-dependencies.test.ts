/**
 * Code under libs/ runs from source in development (ts-node + tsconfig-paths) and there resolves its npm
 * packages from the repository root, not from the importing service: every package it loads at runtime
 * must be in the root package.json. A miss fails silently where the import is optional, as
 * cache-invalidation's iovalkey was: the dev gateway never subscribed to the admin's invalidations, so a
 * catalog change reached an existing key only when its cache entry expired. Built images are unaffected
 * (libs are compiled into each service's dist and resolve from its node_modules).
 */
import * as fs from 'fs';
import * as path from 'path';
import { isBuiltin } from 'module';
import { execFileSync } from 'child_process';
import { describe, it, expect } from '@jest/globals';

const LIBS = path.resolve(__dirname, '../../../libs');
// Separate workspace packages with their own package.json and node_modules.
const OWN_PACKAGES = new Set(['test-utils']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', 'test'].includes(entry.name) || (dir === LIBS && OWN_PACKAGES.has(entry.name)) ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Bare package names a file loads at runtime: `import ... from`, `require(...)`; type-only imports excluded. */
function runtimePackages(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const specifiers = [
    ...[...text.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  return specifiers
    .filter((s) => !s.startsWith('.') && !s.startsWith('@libs/') && !isBuiltin(s))
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
}

describe('libs runtime dependencies', () => {
  const imports = sourceFiles(LIBS).flatMap((file) => runtimePackages(file).map((pkg) => ({ file: path.relative(LIBS, file), pkg })));

  it('finds the packages libs load (the scan works)', () => {
    expect(imports.map((i) => i.pkg)).toEqual(expect.arrayContaining(['iovalkey', 'express']));
  });

  it('every package libs load at runtime resolves from the importing file', () => {
    // A real Node resolver: jest's own require.resolve also searches this service's node_modules.
    const pairs = imports.map(({ file, pkg }) => [path.dirname(path.join(LIBS, file)), pkg]);
    const script = `const { createRequire } = require('module'); const out = [];
      for (const [dir, pkg] of JSON.parse(process.argv[1])) {
        try { createRequire(dir + '/index.js').resolve(pkg); } catch { out.push(pkg + ' from ' + dir); }
      }
      console.log(JSON.stringify(out));`;
    const unresolved = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(pairs)], { encoding: 'utf8', env: { PATH: process.env.PATH } }))
      .map((s: string) => s.replace(LIBS, 'libs'));
    expect(unresolved).toEqual([]);
  });
});
