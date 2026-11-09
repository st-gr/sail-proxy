// After a build, every root-absolute href/src in the HTML must start with the base path; a bare
// "/guide/..." works in dev and 404s on GitHub Pages. Usage: node scripts/check-base.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/sail-proxy/';
const ATTR = /\b(?:href|src)="(\/[^"]*)"/g;

export function baselessRefs(html, base) {
  const out = [];
  for (const m of html.matchAll(ATTR)) if (!m[1].startsWith(base) && !m[1].startsWith('//')) out.push(m[1]);
  return out;
}

function* htmlFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (p.endsWith('.html')) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.vitepress', 'dist');
  let bad = 0;
  for (const f of htmlFiles(dist)) for (const r of baselessRefs(readFileSync(f, 'utf8'), BASE)) { console.error(`${f}: ${r}`); bad++; }
  if (bad) { console.error(`${bad} reference(s) skip the base path ${BASE}`); process.exit(1); }
  console.log('base path check passed');
}
