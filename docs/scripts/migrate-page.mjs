// Rewrites one generated chapter into a site page: strips the pandoc front matter, the repeated
// project header, navigation rows and "(adapted from …)" citations, inlines footnote-style links,
// promotes headings one level and prepends VitePress front matter.
// Usage: node scripts/migrate-page.mjs <file.md> --title "<title>" --description "<description>" [--no-promote]
// --no-promote is for the six pages that never had the generated header and already start with one "# Title".
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FRONT = /^---\n[\s\S]*?\n---\n/;
const HEADER = /^# SAIL-PROXY[^\n]*\n(\*[^\n]*\*\n)?(\*\*Author:\*\*[^\n]*\n)?/m;
const NAV = /^\[?(<< Previous Chapter|Content Table|Next Chapter >>)[^\n]*\n/gm;
const ADAPTED = / ?\(adapted from [^)]*\)/g;
const REF_DEF = /^\[(\d+)\]:\s*(\S+)[^\n]*\n/gm;
const TRAILING_RULE = /\n---\n\s*$/;
const LEADING_RULE = /^\s*---\n/;
const yaml = (v) => (/[:#]/.test(v) ? JSON.stringify(v) : v);

export function migrate(text, { title, description, promote = true }) {
  let t = text.replace(/\r\n/g, '\n').replace(FRONT, '').replace(HEADER, '').replace(NAV, '').replace(ADAPTED, '');
  const refs = {};
  t = t.replace(REF_DEF, (m, n, url) => { refs[n] = url; return ''; });
  t = t.replace(/\[([^\]]+)\]\[(\d+)\]/g, (m, label, n) => (refs[n] ? `[${label}](${refs[n]})` : m));
  t = t.replace(TRAILING_RULE, '\n').replace(LEADING_RULE, '');
  if (promote) t = t.replace(/^(#{2,6}) /gm, (m, hashes) => `${hashes.slice(1)} `);
  t = t.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
  return `---\ntitle: ${yaml(title)}\ndescription: ${yaml(description)}\n---\n\n${t}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const title = opt('title'); const description = opt('description'); const promote = !rest.includes('--no-promote');
  if (!file || !title || !description) { console.error('usage: migrate-page.mjs <file> --title <t> --description <d> [--no-promote]'); process.exit(2); }
  writeFileSync(file, migrate(readFileSync(file, 'utf8'), { title, description, promote }));
  console.log(`migrated ${file}${promote ? '' : ' (headings kept)'}`);
}
